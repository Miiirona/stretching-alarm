import { useState, useEffect, useCallback } from 'react';
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

// toISOString()은 UTC 기준 → 자정 이후 시간대 오프셋 구간에서 어제 날짜 반환
// 로컬 달력 날짜를 YYYY-MM-DD 로 반환
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
  const [members,      setMembers]      = useState([]);
  const [mode,         setMode]         = useState('today');
  const [groupLoading, setGroupLoading] = useState(false);
  const [groupError,   setGroupError]   = useState('');
  const [groupName,    setGroupName]    = useState(cfg?.groupName || '');
  const [editingName,  setEditingName]  = useState(false);
  const [nameDraft,    setNameDraft]    = useState('');
  const [nameLoading,  setNameLoading]  = useState(false);

  const DAILY_GOAL = cfg?.dailyGoal ?? 8;
  const HALF_GOAL  = Math.floor(DAILY_GOAL / 2);

  const count  = cfg?.dailyCount ?? 0;
  const myPct  = Math.min(100, Math.round((count / DAILY_GOAL) * 100));

  const todayIdx      = new Date().getDay();
  const isActiveToday = cfg?.activeDays?.includes(todayIdx) ?? false;
  const todayName     = DAY_NAMES[todayIdx];

  const fetchGroup = useCallback(async (currentMode) => {
    if (!cfg?.groupCode || !cfg?.userId) return;
    setGroupLoading(true);
    setGroupError('');
    try {
      const ttl = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30일 TTL

      // ── 미동기화 스트레칭 완료 로그 flush ──
      if (cfg.pendingLogs?.length > 0) {
        const batch = writeBatch(db);
        for (const log of cfg.pendingLogs) {
          const ref = doc(collection(db, 'stretching_logs'));
          batch.set(ref, {
            userId:      cfg.userId,
            groupCode:   cfg.groupCode,
            date:        localDate(new Date(log.completedAt)), // 로컬 날짜 기준
            completedAt: log.completedAt,
            expireAt:    Timestamp.fromDate(ttl),
          });
        }
        await batch.commit();
        const updated = await window.electronAPI.invoke('config:set', { pendingLogs: [] });
        onCfgChange(prev => ({ ...prev, ...updated, pendingLogs: [] }));
      }

      // ── 미동기화 응답/무응답 interaction 로그 flush ──
      if (cfg.pendingInteractions?.length > 0) {
        const batch2 = writeBatch(db);
        for (const interaction of cfg.pendingInteractions) {
          const ref = doc(collection(db, 'interaction_logs'));
          batch2.set(ref, {
            userId:     cfg.userId,
            groupCode:  cfg.groupCode,
            type:       interaction.type,
            occurredAt: interaction.occurredAt,
            date:       localDate(new Date(interaction.occurredAt)), // 로컬 날짜 기준
            expireAt:   Timestamp.fromDate(ttl),
          });
        }
        await batch2.commit();
        const updated2 = await window.electronAPI.invoke('config:set', { pendingInteractions: [] });
        onCfgChange(prev => ({ ...prev, ...updated2, pendingInteractions: [] }));
      }

      // ── 그룹 이름 동기화 ──
      const groupDoc = await getDoc(doc(db, 'groups', cfg.groupCode));
      if (groupDoc.exists()) {
        const name = groupDoc.data().groupName || '';
        setGroupName(name);
        if (name !== cfg.groupName) {
          const upd = await window.electronAPI.invoke('config:set', { groupName: name || null });
          onCfgChange(prev => ({ ...prev, ...upd }));
        }
      }

      // ── 그룹 내 사용자 목록 ──
      const usersSnap = await getDocs(
        query(collection(db, 'users'), where('groupCode', '==', cfg.groupCode))
      );
      const userMap = { [cfg.userId]: cfg.nickname };
      usersSnap.forEach(d => { userMap[d.id] = d.data().nickname; });

      // ── 기간별 스트레칭 완료 횟수 집계 ──
      const isToday  = (currentMode ?? mode) === 'today';
      const dateFrom = isToday ? todayStr() : weekStartStr();
      const logsSnap = await getDocs(
        query(
          collection(db, 'stretching_logs'),
          where('groupCode', '==', cfg.groupCode),
          where('date', '>=', dateFrom),
        )
      );
      const counts = {};
      logsSnap.forEach(d => {
        const uid = d.data().userId;
        counts[uid] = (counts[uid] || 0) + 1;
      });

      // 오늘 탭: Firestore 값이 정답 — flush 완료 후 로컬과 불일치 시 동기화
      if (isToday) {
        const fsCount = counts[cfg.userId] ?? 0;
        if (fsCount !== count) {
          const upd = await window.electronAPI.invoke('config:set', {
            dailyCount:  fsCount,
            lastDateStr: new Date().toDateString(),
          });
          onCfgChange(upd);
        }
      }

      // ── 오늘 부재 상태 계산 (오늘 탭 전용) ──
      // interaction_logs 인덱스/규칙 미설정 시 이 블록만 실패해도 나머지는 정상 동작
      const absenceMap = {};
      if (isToday) {
        try {
          const iLogsSnap = await getDocs(
            query(
              collection(db, 'interaction_logs'),
              where('groupCode', '==', cfg.groupCode),
              where('date', '==', todayStr()),
            )
          );
          const byUser = {};
          iLogsSnap.forEach(d => {
            const { userId: uid, type, occurredAt } = d.data();
            if (!byUser[uid]) byUser[uid] = [];
            byUser[uid].push({ type, occurredAt });
          });

          for (const uid of Object.keys(userMap)) {
            const logs = byUser[uid];
            if (!logs || logs.length === 0) {
              absenceMap[uid] = 'full_absent';
            } else {
              logs.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
              let consecutive = 0;
              for (let i = logs.length - 1; i >= 0; i--) {
                if (logs[i].type === 'no_response') consecutive++;
                else break;
              }
              absenceMap[uid] = consecutive >= 3 ? 'partial_absent' : 'active';
            }
          }
        } catch (e) {
          console.warn('[Dashboard] interaction_logs 조회 실패 (인덱스/규칙 확인 필요):', e.message);
          // 실패 시 전원 active 처리 — 그룹 데이터 표시는 계속
        }
      }

      const list = Object.entries(userMap).map(([uid, nick]) => ({
        userId:        uid,
        nickname:      nick,
        count:         counts[uid] || 0,
        isMe:          uid === cfg.userId,
        absenceStatus: isToday ? (absenceMap[uid] ?? 'active') : 'active',
      }));
      list.sort((a, b) => b.count - a.count);
      setMembers(list);
    } catch (e) {
      console.error('[Dashboard] fetchGroup:', e);
      setGroupError('그룹 데이터를 불러오지 못했어요');
    } finally {
      setGroupLoading(false);
    }
  }, [cfg, mode, count, onCfgChange]);

  useEffect(() => {
    if (cfg?.groupCode) fetchGroup(mode);
    else setMembers([]);
  }, [cfg?.groupCode, mode]); // eslint-disable-line

  const handleModeChange = (m) => { setMode(m); fetchGroup(m); };

  async function saveGroupName() {
    setNameLoading(true);
    try {
      const name = nameDraft.trim();
      await setDoc(doc(db, 'groups', cfg.groupCode), { groupName: name }, { merge: true });
      const upd = await window.electronAPI.invoke('config:set', { groupName: name || null });
      onCfgChange(prev => ({ ...prev, ...upd }));
      setGroupName(name);
      setEditingName(false);
    } catch (e) {
      console.error('[Dashboard] saveGroupName:', e);
    } finally { setNameLoading(false); }
  }

  // 이번 주 월~오늘 중 가동 요일(activeDays) 해당 일수 계산
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

  // 오늘 탭: 종일 부재(full_absent) 제외, 반차(partial_absent)는 HALF_GOAL 적용
  // 이번 주 탭: 팀원 수 × 하루 목표 × 이번 주 경과 가동일 수
  const totalGoal = mode === 'today'
    ? members
        .filter(m => m.absenceStatus !== 'full_absent')
        .reduce((s, m) => s + (m.absenceStatus === 'partial_absent' ? HALF_GOAL : DAILY_GOAL), 0)
    : members.length * DAILY_GOAL * activeWeekDayCount;
  const totalCount = members.reduce((s, m) => s + m.count, 0);
  const teamPct    = totalGoal > 0 ? Math.min(100, Math.round((totalCount / totalGoal) * 100)) : 0;
  const hasAbsent  = mode === 'today' && members.some(m => m.absenceStatus !== 'active');
  const maxCount   = Math.max(...members.map(m => m.count), 1);

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

          {/* 헤더: 라벨 + 요일 배지 */}
          <div className="dash-today-top">
            <span className="dash-card-label" style={{ marginBottom: 0 }}>오늘의 스트레칭</span>
            <span className={`dash-day-chip${isActiveToday ? ' on' : ''}`}>
              {todayName}요일{isActiveToday ? '' : ' · 쉬는 날'}
            </span>
          </div>

          {/* 메인: 횟수 + 달성 배지 */}
          <div className="dash-today-stat">
            <span className="dash-count-num">{count}</span>
            <span className={`dash-count-badge${count >= DAILY_GOAL ? ' done' : ''}`}>
              {count >= DAILY_GOAL ? '🎉 목표 달성!' : `/ ${DAILY_GOAL}회`}
            </span>
          </div>

          {/* 도트 */}
          <div className="dash-dots">
            {Array.from({ length: DAILY_GOAL }).map((_, i) => (
              <div key={i} className={`dash-dot${i < count ? ' on' : ''}`} />
            ))}
          </div>

          <div className="dash-group-divider" style={{ margin: '14px 0 12px' }} />

          {/* 스케줄 */}
          <div className="dash-schedule-row">
            <span className="dash-schedule-info">
              {String(cfg.startHour).padStart(2,'0')}:00 ~ {String(cfg.endHour).padStart(2,'0')}:00
            </span>
            <span className="dash-schedule-sep">·</span>
            <span className="dash-schedule-info">{fmtInterval(cfg.intervalMinutes)}</span>
          </div>
        </section>

        {/* ── 그룹 현황 ── */}
        {cfg?.groupCode ? (
          <section className="dash-card dash-group-card">

            {/* 상단: 라벨 + 새로고침 */}
            <div className="dash-group-top">
              <span className="dash-card-label" style={{ marginBottom: 0 }}>그룹 현황</span>
              <button className="dash-refresh" onClick={() => fetchGroup()} disabled={groupLoading}
                aria-label="새로고침">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M1 4v6h6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M3.51 15a9 9 0 1 0 .49-4.33" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>

            {/* 그룹 이름 + 인라인 편집 */}
            <div className="dash-group-name-area">
              {editingName ? (
                <div className="dash-name-edit-row">
                  <input className="dash-name-input" autoFocus value={nameDraft}
                    onChange={e => setNameDraft(e.target.value)} maxLength={20}
                    placeholder="그룹 이름" />
                  <button className="dash-name-btn save" onClick={saveGroupName} disabled={nameLoading}>저장</button>
                  <button className="dash-name-btn cancel" onClick={() => setEditingName(false)}>취소</button>
                </div>
              ) : (
                <div className="dash-group-title-row">
                  <span className="dash-group-name">{groupName || cfg.groupCode}</span>
                  <button className="dash-edit-name-btn" onClick={() => { setNameDraft(groupName); setEditingName(true); }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
              )}
              <div className="dash-group-sub">
                <span className="dash-group-code-small">{cfg.groupCode}</span>
                <span className="dash-group-me-badge">나 · {cfg.nickname}</span>
              </div>
            </div>

            {/* 기간 토글 */}
            <div className="dash-mode-row">
              <button className={`dash-mode-pill${mode === 'today' ? ' on' : ''}`}
                onClick={() => handleModeChange('today')}>오늘</button>
              <button className={`dash-mode-pill${mode === 'week' ? ' on' : ''}`}
                onClick={() => handleModeChange('week')}>이번 주</button>
            </div>

            <div className="dash-group-divider" />

            {/* 콘텐츠 */}
            {groupError ? (
              <p className="dash-error">{groupError}</p>
            ) : groupLoading ? (
              <div className="dash-group-loading">불러오는 중...</div>
            ) : members.length > 0 ? (
              <>
                {/* 팀 달성률 */}
                <div className="dash-team-gauge">
                  <div className="dash-team-gauge-header">
                    <span className="dash-team-label">팀 달성률</span>
                    <span className="dash-team-pct">{teamPct}%</span>
                  </div>
                  <div className="dash-team-gauge-track">
                    <div className="dash-team-gauge-fill" style={{ width: `${teamPct}%` }} />
                  </div>
                  <span className="dash-team-detail">
                    총 {totalCount}회 · 목표 {totalGoal}회
                    {mode === 'week' && <span> · {activeWeekDayCount}일치</span>}
                    {hasAbsent && <span className="dash-absent-note"> · 부재 보정 적용</span>}
                  </span>
                </div>

                {/* 멤버 리스트 */}
                <div className="dash-members">
                  {members.map((m, i) => {
                    const pct = Math.round((m.count / maxCount) * 100);
                    const rankClass = i < 3 ? ` r${i + 1}` : '';
                    const medals = ['🥇', '🥈', '🥉'];
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
        ) : (
          /* 그룹 없는 상태 */
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
