import { useState, useEffect, useCallback, useRef } from 'react';
import { db } from './firebase.js';
import {
  doc, getDoc, getDocs, writeBatch, setDoc, Timestamp,
  collection, query, where,
} from 'firebase/firestore';
import './Dashboard.css';

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

function fmtInterval(m) {
  if (m < 60) return `${m}분마다`;
  const h = Math.floor(m / 60), min = m % 60;
  return min === 0 ? `${h}시간마다` : `${h}시간 ${min}분마다`;
}

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

const todayStr     = () => localDate();
const weekStartStr = () => {
  const d = new Date();
  const diff = d.getDay() === 0 ? -6 : 1 - d.getDay();
  const mon = new Date(d); mon.setDate(d.getDate() + diff);
  return localDate(mon);
};

export default function Dashboard({ cfg, onCfgChange, onSettingsOpen }) {
  const [groupsData,     setGroupsData]     = useState([]);
  const [mode,           setMode]           = useState('today');
  const [groupLoading,   setGroupLoading]   = useState(false);
  const [groupError,     setGroupError]     = useState('');
  const [editingGCode,   setEditingGCode]   = useState(null); // 이름 편집 중인 그룹코드
  const [nameDraft,      setNameDraft]      = useState('');
  const [nameLoading,    setNameLoading]    = useState(false);

  const DAILY_GOAL = cfg?.dailyGoal ?? 8;
  const HALF_GOAL  = Math.floor(DAILY_GOAL / 2);
  const count      = cfg?.dailyCount ?? 0;

  const todayIdx      = new Date().getDay();
  const isActiveToday = cfg?.activeDays?.includes(todayIdx) ?? false;
  const todayName     = DAY_NAMES[todayIdx];

  const activeWeekDayCount = (() => {
    const d = new Date();
    const daysSinceMon = d.getDay() === 0 ? 6 : d.getDay() - 1;
    let n = 0;
    for (let i = 0; i <= daysSinceMon; i++) {
      const day = new Date(d);
      day.setDate(d.getDate() - daysSinceMon + i);
      if (cfg?.activeDays?.includes(day.getDay())) n++;
    }
    return Math.max(n, 1);
  })();

  const fetchAllGroups = useCallback(async (currentMode) => {
    const groups = cfg?.groups ?? [];
    if (!cfg?.userId || groups.length === 0) { setGroupsData([]); return; }
    setGroupLoading(true);
    setGroupError('');
    try {
      const ttl    = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const isToday = (currentMode ?? mode) === 'today';
      const dateFrom = isToday ? todayStr() : weekStartStr();

      // ── 미동기화 스트레칭 완료 로그 → 모든 그룹에 flush ──
      // config:get으로 최신값을 가져와 클로저 stale 문제 방지
      const freshCfg = await window.electronAPI.invoke('config:get');
      const pendingLogs = freshCfg?.pendingLogs ?? cfg.pendingLogs ?? [];
      if (pendingLogs.length > 0) {
        const batch = writeBatch(db);
        for (const log of pendingLogs) {
          for (const g of groups) {
            const docId = `${cfg.userId}_${g.groupCode}_${log.completedAt.replace(/[:.]/g, '-')}`;
            batch.set(doc(db, 'stretching_logs', docId), {
              userId:      cfg.userId,
              groupCode:   g.groupCode,
              date:        localDate(new Date(log.completedAt)),
              completedAt: log.completedAt,
              expireAt:    Timestamp.fromDate(ttl),
            });
          }
        }
        await batch.commit();
        const upd = await window.electronAPI.invoke('config:set', { pendingLogs: [] });
        onCfgChange(prev => ({ ...prev, ...upd, pendingLogs: [] }));
      }

      // ── 미동기화 interaction 로그 → 모든 그룹에 flush ──
      if (cfg.pendingInteractions?.length > 0) {
        const batch2 = writeBatch(db);
        for (const ia of cfg.pendingInteractions) {
          for (const g of groups) {
            const docId = `${cfg.userId}_${g.groupCode}_${ia.occurredAt.replace(/[:.]/g, '-')}`;
            batch2.set(doc(db, 'interaction_logs', docId), {
              userId:     cfg.userId,
              groupCode:  g.groupCode,
              type:       ia.type,
              occurredAt: ia.occurredAt,
              date:       localDate(new Date(ia.occurredAt)),
              expireAt:   Timestamp.fromDate(ttl),
            });
          }
        }
        await batch2.commit();
        const upd2 = await window.electronAPI.invoke('config:set', { pendingInteractions: [] });
        onCfgChange(prev => ({ ...prev, ...upd2, pendingInteractions: [] }));
      }

      // ── 그룹별 데이터 병렬 조회 ──
      const results = await Promise.all(groups.map(async (g) => {
        // 그룹 이름
        const groupDoc = await getDoc(doc(db, 'groups', g.groupCode));
        const gName = groupDoc.exists() ? (groupDoc.data().groupName || '') : g.groupName || '';

        // 멤버 목록 — v1.0.1 이전 doc은 userId 필드 없이 doc.id = userId 형식이므로 fallback 처리
        const usersSnap = await getDocs(
          query(collection(db, 'users'), where('groupCode', '==', g.groupCode))
        );
        const userMap = { [cfg.userId]: cfg.nickname };
        usersSnap.forEach(d => {
          const uid = d.data().userId ?? d.id;
          userMap[uid] = d.data().nickname;
        });

        // 완료 횟수 집계
        const logsSnap = await getDocs(
          query(
            collection(db, 'stretching_logs'),
            where('groupCode', '==', g.groupCode),
            where('date', '>=', dateFrom),
          )
        );
        const counts = {};
        logsSnap.forEach(d => {
          const uid = d.data().userId;
          counts[uid] = (counts[uid] || 0) + 1;
        });

        // 오늘 탭: 로컬 count가 Firestore보다 낮으면 동기화 (UP 방향만)
        if (isToday) {
          const fsCount = counts[cfg.userId] ?? 0;
          if (fsCount > count) {
            const upd = await window.electronAPI.invoke('config:set', {
              dailyCount:  fsCount,
              lastDateStr: new Date().toDateString(),
            });
            onCfgChange(upd);
          }
        }

        // 부재 감지 (오늘 탭 전용)
        const absenceMap = {};
        if (isToday) {
          try {
            const iSnap = await getDocs(
              query(
                collection(db, 'interaction_logs'),
                where('groupCode', '==', g.groupCode),
                where('date', '==', todayStr()),
              )
            );
            const byUser = {};
            iSnap.forEach(d => {
              const { userId: uid, type, occurredAt } = d.data();
              if (!byUser[uid]) byUser[uid] = [];
              byUser[uid].push({ type, occurredAt });
            });
            for (const uid of Object.keys(userMap)) {
              const logs = byUser[uid];
              if (!logs?.length) {
                absenceMap[uid] = 'full_absent';
              } else {
                logs.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
                let consec = 0;
                for (let i = logs.length - 1; i >= 0; i--) {
                  if (logs[i].type === 'no_response') consec++;
                  else break;
                }
                absenceMap[uid] = consec >= 3 ? 'partial_absent' : 'active';
              }
            }
          } catch (e) {
            console.warn('[Dashboard] interaction_logs 조회 실패:', e.message);
          }
        }

        const members = Object.entries(userMap).map(([uid, nick]) => ({
          userId:        uid,
          nickname:      nick,
          count:         counts[uid] || 0,
          isMe:          uid === cfg.userId,
          absenceStatus: isToday ? (absenceMap[uid] ?? 'active') : 'active',
        }));
        members.sort((a, b) => b.count - a.count);

        // 팀 달성률 계산
        const totalGoal = isToday
          ? members
              .filter(m => m.absenceStatus !== 'full_absent')
              .reduce((s, m) => s + (m.absenceStatus === 'partial_absent' ? HALF_GOAL : DAILY_GOAL), 0)
          : members.length * DAILY_GOAL * activeWeekDayCount;
        const totalCount = members.reduce((s, m) => s + m.count, 0);
        const teamPct    = totalGoal > 0 ? Math.min(100, Math.round((totalCount / totalGoal) * 100)) : 0;
        const hasAbsent  = isToday && members.some(m => m.absenceStatus !== 'active');
        const maxCount   = Math.max(...members.map(m => m.count), 1);

        return { groupCode: g.groupCode, groupName: gName, members, totalGoal, totalCount, teamPct, hasAbsent, maxCount };
      }));

      // 그룹 이름이 바뀐 경우 config 업데이트
      const updGroups = groups.map(g => {
        const r = results.find(r => r.groupCode === g.groupCode);
        return r ? { ...g, groupName: r.groupName } : g;
      });
      if (JSON.stringify(updGroups) !== JSON.stringify(groups)) {
        const upd = await window.electronAPI.invoke('config:set', { groups: updGroups });
        onCfgChange(prev => ({ ...prev, ...upd }));
      }

      setGroupsData(results);
    } catch (e) {
      console.error('[Dashboard] fetchAllGroups:', e);
      setGroupError('그룹 데이터를 불러오지 못했어요');
    } finally {
      setGroupLoading(false);
    }
  }, [cfg, mode, count, onCfgChange, DAILY_GOAL, HALF_GOAL, activeWeekDayCount]);

  useEffect(() => {
    fetchAllGroups(mode);
  }, [cfg?.groups?.length, mode]); // eslint-disable-line

  const prevDailyCount = useRef(null);
  useEffect(() => {
    const c = cfg?.dailyCount ?? 0;
    if (prevDailyCount.current !== null && c > prevDailyCount.current && (cfg?.groups?.length ?? 0) > 0) {
      fetchAllGroups(mode);
    }
    prevDailyCount.current = c;
  }, [cfg?.dailyCount]); // eslint-disable-line

  const handleModeChange = (m) => { setMode(m); fetchAllGroups(m); };

  async function saveGroupName(groupCode) {
    setNameLoading(true);
    try {
      const name = nameDraft.trim();
      await setDoc(doc(db, 'groups', groupCode), { groupName: name }, { merge: true });
      const updGroups = (cfg.groups ?? []).map(g =>
        g.groupCode === groupCode ? { ...g, groupName: name } : g
      );
      const upd = await window.electronAPI.invoke('config:set', { groups: updGroups });
      onCfgChange(prev => ({ ...prev, ...upd }));
      setGroupsData(prev => prev.map(g =>
        g.groupCode === groupCode ? { ...g, groupName: name } : g
      ));
      setEditingGCode(null);
    } catch (e) {
      console.error('[Dashboard] saveGroupName:', e);
    } finally { setNameLoading(false); }
  }

  const hasGroups = (cfg?.groups?.length ?? 0) > 0;

  return (
    <div className="dash-root">

      {/* 헤더 */}
      <header className="dash-header">
        <div className="dash-brand">
          <div className="dash-brand-icon">
            <svg width="15" height="15" viewBox="0 0 24 24">
              <rect x="10.5" y="0" width="3" height="3.5" rx="1.5" fill="#fff"/>
              <path d="M12 3.5 C16.5 3.5,21 7.5,21 13 L21 17 L3 17 L3 13 C3 7.5,7.5 3.5,12 3.5 Z" fill="#fff"/>
              <rect x="2" y="16.5" width="20" height="2.5" rx="1.25" fill="#fff"/>
              <circle cx="12" cy="21.5" r="1.5" fill="#fff"/>
            </svg>
          </div>
          <span className="dash-brand-name">StretchWidget</span>
          {cfg.isDev && <span className="dash-dev-badge">DEV</span>}
        </div>
        <button className="dash-gear" onClick={onSettingsOpen} aria-label="설정">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="2"/>
          </svg>
        </button>
      </header>

      <div className="dash-scroll">

        {/* ── 오늘의 스트레칭 ── */}
        <section className="dash-card dash-today-card">

          <div className="dash-today-top">
            <span className="dash-card-label" style={{ marginBottom: 0 }}>오늘의 스트레칭</span>
            <span className={`dash-day-chip${isActiveToday ? ' on' : ''}`}>
              {todayName}요일{isActiveToday ? '' : ' · 쉬는 날'}
            </span>
          </div>

          <div className="dash-today-stat">
            <span className="dash-count-num">{count}</span>
            <span className={`dash-count-badge${count >= DAILY_GOAL ? ' done' : ''}`}>
              {count >= DAILY_GOAL ? '🎉 목표 달성!' : `/ ${DAILY_GOAL}회`}
            </span>
          </div>

          {/* 다음 알림 / 방해금지 오버레이 */}
          {(() => {
            const isDnd = cfg.dndUntil && Date.now() < cfg.dndUntil;
            const fmtTime = (ms) => {
              const d = new Date(ms);
              const t = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
              return d.toDateString() === new Date().toDateString() ? t : `내일 ${t}`;
            };
            if (isDnd) return (
              <div className="dash-dots-meta">
                <span className="dash-dnd-inline">🔕 방해금지 중 · {fmtTime(cfg.dndUntil)}까지</span>
                <button className="dash-dnd-inline-cancel" onClick={async () => {
                  const upd = await window.electronAPI.invoke('dnd:cancel');
                  onCfgChange(upd);
                }}>해제</button>
              </div>
            );
            if (cfg.nextAlarmAt && Date.now() < cfg.nextAlarmAt) return (
              <div className="dash-dots-meta">
                <span className="dash-next-inline">다음 알림 {fmtTime(cfg.nextAlarmAt)}</span>
              </div>
            );
            return null;
          })()}

          {/* 도트 게이지 */}
          <div className="dash-dots" style={{ gridTemplateColumns: `repeat(${DAILY_GOAL}, 1fr)` }}>
            {(() => {
              const logs = (cfg.todayLogs ?? []).slice(-count);
              return Array.from({ length: Math.max(DAILY_GOAL, count) }).map((_, i) => {
                const t = logs[i] ? new Date(logs[i].completedAt) : null;
                const timeStr = (i < count && t)
                  ? `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`
                  : undefined;
                const isBonus = i >= DAILY_GOAL;
                return (
                  <div key={i} className="dash-dot-wrap" data-time={timeStr}>
                    <div className={`dash-dot${i < count ? (isBonus ? ' bonus' : ' on') : ''}`} />
                  </div>
                );
              });
            })()}
          </div>

          {/* DEV 전용: 오늘 기록 초기화 */}
          {cfg.isDev && (
            <button className="dash-dev-reset" onClick={async () => {
              try {
                const snap = await getDocs(query(
                  collection(db, 'stretching_logs'),
                  where('userId', '==', cfg.userId),
                  where('date', '==', todayStr()),
                ));
                if (!snap.empty) {
                  const batch = writeBatch(db);
                  snap.forEach(d => batch.delete(d.ref));
                  await batch.commit();
                }
              } catch (e) { console.warn('[DEV reset] Firestore 삭제 실패:', e.message); }
              const upd = await window.electronAPI.invoke('config:set', {
                dailyCount: 0, todayLogs: [], pendingLogs: [],
                lastDateStr: new Date().toDateString(),
              });
              onCfgChange(upd);
            }}>[DEV] 오늘 기록 초기화</button>
          )}

          <div className="dash-group-divider" style={{ margin: '14px 0 12px' }} />

          <div className="dash-schedule-row">
            <span className="dash-schedule-info">
              {String(cfg.startHour).padStart(2,'0')}:00 ~ {String(cfg.endHour).padStart(2,'0')}:00
            </span>
            <span className="dash-schedule-sep">·</span>
            <span className="dash-schedule-info">{fmtInterval(cfg.intervalMinutes)}</span>
          </div>
        </section>

        {/* ── 오늘의 영양제 (컴팩트 칩) ── */}
        {cfg.supplementsEnabled && (cfg.supplements ?? []).length > 0 && (
          <section className="dash-card dash-supp-card">
            <div className="dash-supp-row">
              <span className="dash-supp-label">영양제</span>
              <div className="dash-supp-chips">
                {(cfg.supplements ?? []).map(sup => {
                  const taken = (cfg.supplementLogs ?? []).some(l => l.id === sup.id);
                  return (
                    <button key={sup.id} className={`dash-supp-chip${taken ? ' taken' : ''}`}
                      onClick={async () => {
                        const upd = await window.electronAPI.invoke('supplement:toggle', sup.id);
                        onCfgChange(upd);
                      }}>
                      <span className="dash-supp-chip-check">{taken ? '✓' : '○'}</span>
                      {sup.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {/* ── 그룹 현황 ── */}
        {hasGroups ? (
          <>
            {/* 헤더 행: 라벨 + 새로고침 + 기간 토글 */}
            <div className="dash-group-header">
              <div className="dash-group-header-left">
                <span className="dash-card-label" style={{ marginBottom: 0 }}>그룹 현황</span>
                <button className="dash-refresh" onClick={() => fetchAllGroups()} disabled={groupLoading}
                  aria-label="새로고침">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                    <path d="M1 4v6h6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M3.51 15a9 9 0 1 0 .49-4.33" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </div>
              <div className="dash-mode-row" style={{ marginBottom: 0 }}>
                <button className={`dash-mode-pill${mode === 'today' ? ' on' : ''}`}
                  onClick={() => handleModeChange('today')}>오늘</button>
                <button className={`dash-mode-pill${mode === 'week' ? ' on' : ''}`}
                  onClick={() => handleModeChange('week')}>이번 주</button>
              </div>
            </div>

            {groupError && <p className="dash-error" style={{ padding: '0 2px' }}>{groupError}</p>}
            {groupLoading && groupsData.length === 0 && (
              <div className="dash-group-loading">불러오는 중...</div>
            )}

            {/* 그룹별 독립 카드 */}
            {groupsData.map((gData) => (
              <section key={gData.groupCode} className="dash-card dash-group-card">

                {/* 그룹 이름 */}
                <div className="dash-group-name-area">
                  {editingGCode === gData.groupCode ? (
                    <div className="dash-name-edit-row">
                      <input className="dash-name-input" autoFocus value={nameDraft}
                        onChange={e => setNameDraft(e.target.value)} maxLength={20}
                        placeholder="그룹 이름" />
                      <button className="dash-name-btn save"
                        onClick={() => saveGroupName(gData.groupCode)} disabled={nameLoading}>저장</button>
                      <button className="dash-name-btn cancel"
                        onClick={() => setEditingGCode(null)}>취소</button>
                    </div>
                  ) : (
                    <div className="dash-group-title-row">
                      <span className="dash-group-name">{gData.groupName || gData.groupCode}</span>
                      <button className="dash-edit-name-btn" onClick={() => {
                        setNameDraft(gData.groupName || '');
                        setEditingGCode(gData.groupCode);
                      }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
                    </div>
                  )}
                  <div className="dash-group-sub">
                    <span className="dash-group-code-small">{gData.groupCode}</span>
                  </div>
                </div>

                {/* 팀 달성률 + 멤버 리스트 */}
                {gData.members.length > 0 ? (
                  <>
                    <div className="dash-team-gauge">
                      <div className="dash-team-gauge-header">
                        <span className="dash-team-label">팀 달성률</span>
                        <span className="dash-team-pct">{gData.teamPct}%</span>
                      </div>
                      <div className="dash-team-gauge-track">
                        <div className="dash-team-gauge-fill" style={{ width: `${gData.teamPct}%` }} />
                      </div>
                      <span className="dash-team-detail">
                        총 {gData.totalCount}회 · 목표 {gData.totalGoal}회
                        {mode === 'week' && <span> · {activeWeekDayCount}일치</span>}
                        {gData.hasAbsent && <span className="dash-absent-note"> · 부재 보정 적용</span>}
                      </span>
                    </div>

                    <div className="dash-members">
                      {gData.members.map((m, i) => {
                        const pct      = Math.round((m.count / gData.maxCount) * 100);
                        const rankClass = i < 3 ? ` r${i + 1}` : '';
                        const medals   = ['🥇', '🥈', '🥉'];
                        return (
                          <div key={m.userId} className={`dash-member${m.isMe ? ' me' : ''}`}>
                            <div className={`dash-rank${rankClass}`}>
                              {i < 3 ? medals[i] : i + 1}
                            </div>
                            <div className="dash-member-body">
                              <div className="dash-member-top">
                                <div className="dash-member-name-row">
                                  <span className="dash-member-name">{m.nickname}</span>
                                  {m.isMe && <span className="dash-me-tag">나</span>}
                                  {mode === 'today' && m.absenceStatus !== 'active' && (
                                    <span className="dash-away-badge">
                                      {m.absenceStatus === 'full_absent' ? '종일 자리비움' : '자리비움'} 💤
                                    </span>
                                  )}
                                </div>
                                <span className="dash-member-cnt">
                                  {m.count}회
                                  {mode === 'today' && m.absenceStatus === 'partial_absent' && (
                                    <span className="dash-member-goal-note">/{HALF_GOAL}</span>
                                  )}
                                </span>
                              </div>
                              <div className="dash-bar-track">
                                <div className="dash-bar-fill"
                                  style={{ width: `${pct}%`, opacity: m.count === 0 ? 0 : 1 }} />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <p className="dash-empty">아직 완료 기록이 없어요</p>
                )}
              </section>
            ))}
          </>
        ) : (
          <section className="dash-card dash-no-group">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="dash-no-group-icon">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="rgba(255,255,255,0.22)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="9" cy="7" r="4" stroke="rgba(255,255,255,0.22)" strokeWidth="2"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="rgba(255,255,255,0.22)" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <p className="dash-no-group-text">팀원들과 스트레칭 현황을<br/>함께 공유해보세요</p>
            <button className="dash-no-group-btn" onClick={onSettingsOpen}>그룹 설정하기</button>
          </section>
        )}

      </div>
    </div>
  );
}
