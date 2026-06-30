import { useState, useEffect } from 'react';
import { db } from './firebase.js';
import { doc, setDoc, getDoc, deleteDoc, getDocs, collection, query, where } from 'firebase/firestore';
import './App.css';

const DAYS         = ['일', '월', '화', '수', '목', '금', '토'];
const INTERVAL_MIN = 10, INTERVAL_MAX = 240, INTERVAL_STEP = 10;

function formatMinutes(m) {
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60), min = m % 60;
  return min === 0 ? `${h}시간` : `${h}시간 ${min}분`;
}

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function formatTime12(time) {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  const pm = h >= 12;
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${pm ? '오후' : '오전'} ${h12}:${String(m).padStart(2, '0')}`;
}

function TimePicker({ value, onChange }) {
  const parse = (v) => {
    const p = (v || '09:00').split(':');
    const h24 = parseInt(p[0], 10) || 0;
    const min = parseInt(p[1], 10) || 0;
    const pm = h24 >= 12;
    const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
    return { h24, min, pm, h12 };
  };

  const { h24, min, pm: isPm, h12 } = parse(value);
  const [hText, setHText] = useState(String(h12));
  const [mText, setMText] = useState(String(min).padStart(2, '0'));

  useEffect(() => {
    const { h12: hh, min: mm } = parse(value);
    setHText(String(hh));
    setMText(String(mm).padStart(2, '0'));
  }, [value]);

  const f2 = (n) => String(n).padStart(2, '0');

  const to24 = (h12val, pm) => {
    let h = parseInt(h12val, 10);
    if (isNaN(h) || h < 1) h = 12;
    if (h > 12) h = 12;
    return pm ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
  };

  const commit = (newH24, newMin) => onChange(`${f2(newH24)}:${f2(newMin)}`);

  const commitHour = (text) => {
    let h = parseInt(text, 10);
    if (isNaN(h) || h < 1) h = 12;
    if (h > 12) h = 12;
    setHText(String(h));
    commit(to24(h, isPm), min);
  };

  const commitMinute = (text) => {
    let m = parseInt(text, 10);
    if (isNaN(m) || m < 0) m = 0;
    if (m > 59) m = 59;
    setMText(f2(m));
    commit(to24(hText, isPm), m);
  };

  const stepHour = (delta) => {
    let h = (parseInt(hText, 10) || 12) + delta;
    if (h < 1) h = 12;
    if (h > 12) h = 1;
    setHText(String(h));
    commit(to24(h, isPm), min);
  };

  const stepMinute = (delta) => {
    let m = Math.round(min / 5) * 5 + delta;
    if (m < 0) m = 55;
    if (m >= 60) m = 0;
    setMText(f2(m));
    commit(to24(hText, isPm), m);
  };

  const setPeriod = (pm) => commit(to24(hText, pm), min);

  return (
    <div className="supp-time-picker">
      <div className="supp-time-unit">
        <button className="hour-arrow" onClick={() => stepHour(-1)}>‹</button>
        <input
          className="supp-time-input"
          value={hText}
          onChange={e => setHText(e.target.value.replace(/\D/g, ''))}
          onBlur={e => commitHour(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && commitHour(e.target.value)}
          maxLength={2}
        />
        <button className="hour-arrow" onClick={() => stepHour(1)}>›</button>
      </div>
      <span className="supp-time-colon">:</span>
      <div className="supp-time-unit">
        <button className="hour-arrow" onClick={() => stepMinute(-5)}>‹</button>
        <input
          className="supp-time-input"
          value={mText}
          onChange={e => setMText(e.target.value.replace(/\D/g, ''))}
          onBlur={e => commitMinute(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && commitMinute(e.target.value)}
          maxLength={2}
        />
        <button className="hour-arrow" onClick={() => stepMinute(5)}>›</button>
      </div>
      <div className="supp-ampm-toggle">
        <button className={`supp-ampm-btn${!isPm ? ' active' : ''}`} onClick={() => setPeriod(false)}>오전</button>
        <button className={`supp-ampm-btn${isPm ? ' active' : ''}`} onClick={() => setPeriod(true)}>오후</button>
      </div>
    </div>
  );
}

function HourPicker({ label, value, min, max, onChange }) {
  return (
    <div className="hour-picker">
      <span className="hour-picker-label">{label}</span>
      <div className="hour-picker-ctrl">
        <button className="hour-arrow" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>‹</button>
        <span className="hour-val">{String(value).padStart(2, '0')}시</span>
        <button className="hour-arrow" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>›</button>
      </div>
    </div>
  );
}

export default function Settings({ cfg, onBack, onCfgChange }) {
  const [local,     setLocal]     = useState({ ...cfg });
  const [saveState, setSaveState] = useState('idle');

  const [groupView,      setGroupView]      = useState('main');
  const [nickname,       setNickname]       = useState(cfg?.nickname || '');
  const [groupNameInput, setGroupNameInput] = useState('');
  const [codeInput,      setCodeInput]      = useState('');
  const [createdCode,    setCreatedCode]    = useState('');
  const [codeCopied,     setCodeCopied]     = useState(false);
  const [groupLoad,      setGroupLoad]      = useState(false);
  const [groupErr,       setGroupErr]       = useState('');
  const [editingNick,    setEditingNick]    = useState(false);
  const [nickDraft,      setNickDraft]      = useState('');
  const [leavingCode,    setLeavingCode]    = useState(null); // 나가기 중인 그룹코드

  const [addingSupp,    setAddingSupp]    = useState(false);
  const [suppName,      setSuppName]      = useState('');
  const [suppTime,      setSuppTime]      = useState('09:00');
  const [editingSupId,  setEditingSupId]  = useState(null);
  const [editSuppName,  setEditSuppName]  = useState('');
  const [editSuppTime,  setEditSuppTime]  = useState('09:00');

  const currentGroups = local.groups ?? [];

  const update = (key, val) => { setLocal(p => ({ ...p, [key]: val })); setSaveState('idle'); };
  const toggleDay = (idx) => {
    const next = local.activeDays.includes(idx)
      ? local.activeDays.filter(d => d !== idx)
      : [...local.activeDays, idx].sort((a, b) => a - b);
    if (!next.length) return;
    update('activeDays', next);
  };
  const isValid = local.startHour < local.endHour;

  const handleSave = async () => {
    if (!isValid) return;
    try {
      const updated = await window.electronAPI.invoke('config:set', local);
      onCfgChange(updated);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 2000);
    }
  };

  // 새 그룹 추가 시 pendingLogs 계산
  // 미전송 로그가 있으면 재사용, 없으면 todayLogs 에서 재등록 (새 그룹에 오늘 기록 반영)
  function pendingLogsForNewGroup() {
    const existing = cfg.pendingLogs ?? [];
    if (existing.length > 0) return existing;
    const count = cfg.dailyCount ?? 0;
    if (count <= 0) return [];
    return (cfg.todayLogs ?? []).slice(-count);
  }

  async function addGroup(groupCode, nick, gName = '') {
    setGroupLoad(true); setGroupErr('');
    try {
      if (gName) await setDoc(doc(db, 'groups', groupCode), { groupName: gName });
      // 문서 ID: userId_groupCode (멀티그룹 지원)
      await setDoc(doc(db, 'users', `${local.userId}_${groupCode}`), {
        userId:    local.userId,
        groupCode,
        nickname:  nick,
      });
      const newGroup    = { groupCode, groupName: gName || '' };
      const updGroups   = [...currentGroups, newGroup];
      const updated     = await window.electronAPI.invoke('config:set', {
        nickname: nick,
        groups:   updGroups,
        pendingLogs: pendingLogsForNewGroup(),
      });
      onCfgChange(updated);
      setLocal(p => ({ ...p, nickname: nick, groups: updGroups }));
      setGroupView('main');
    } catch { setGroupErr('저장에 실패했어요. Firebase 설정을 확인해주세요.'); }
    finally { setGroupLoad(false); }
  }

  async function joinGroup(code, nick) {
    setGroupLoad(true); setGroupErr('');
    try {
      if (currentGroups.some(g => g.groupCode === code)) {
        setGroupErr('이미 참여 중인 그룹이에요.'); setGroupLoad(false); return;
      }
      const groupDoc = await getDoc(doc(db, 'groups', code));
      if (!groupDoc.exists()) { setGroupErr('존재하지 않는 그룹 코드예요.'); setGroupLoad(false); return; }
      const gName = groupDoc.data().groupName || '';
      await setDoc(doc(db, 'users', `${local.userId}_${code}`), {
        userId:    local.userId,
        groupCode: code,
        nickname:  nick,
      });
      const newGroup  = { groupCode: code, groupName: gName };
      const updGroups = [...currentGroups, newGroup];
      const updated   = await window.electronAPI.invoke('config:set', {
        nickname: nick,
        groups:   updGroups,
        pendingLogs: pendingLogsForNewGroup(),
      });
      onCfgChange(updated);
      setLocal(p => ({ ...p, nickname: nick, groups: updGroups }));
      setGroupView('main');
    } catch { setGroupErr('저장에 실패했어요. 그룹 코드를 확인해주세요.'); }
    finally { setGroupLoad(false); }
  }

  async function saveNickname() {
    setGroupLoad(true); setGroupErr('');
    try {
      const nick = nickDraft.trim();
      // 모든 그룹 멤버십 닉네임 업데이트
      for (const g of currentGroups) {
        await setDoc(
          doc(db, 'users', `${local.userId}_${g.groupCode}`),
          { nickname: nick },
          { merge: true },
        );
      }
      const updated = await window.electronAPI.invoke('config:set', { nickname: nick });
      onCfgChange(updated);
      setLocal(p => ({ ...p, nickname: nick }));
      setEditingNick(false);
    } catch { setGroupErr('닉네임 저장에 실패했어요.'); }
    finally { setGroupLoad(false); }
  }

  async function leaveGroup(groupCode) {
    setLeavingCode(groupCode); setGroupErr('');
    try {
      await deleteDoc(doc(db, 'users', `${local.userId}_${groupCode}`));

      // 남은 멤버가 없으면 그룹 문서도 삭제
      const remaining = await getDocs(
        query(collection(db, 'users'), where('groupCode', '==', groupCode))
      );
      if (remaining.empty) {
        await deleteDoc(doc(db, 'groups', groupCode));
      }

      const updGroups = currentGroups.filter(g => g.groupCode !== groupCode);
      const updated   = await window.electronAPI.invoke('config:set', {
        groups:      updGroups,
        pendingLogs: updGroups.length === 0 ? [] : (local.pendingLogs || []),
      });
      onCfgChange(updated);
      setLocal(p => ({ ...p, groups: updGroups }));
    } catch { setGroupErr('그룹 나가기에 실패했어요.'); }
    finally { setLeavingCode(null); }
  }

  function copyCode(code) {
    navigator.clipboard.writeText(code);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  }

  // ── 그룹 만들기 서브뷰 ───────────────────────────────────────────────────────
  if (groupView === 'create') return (
    <div className="settings-root">
      <button className="st-back st-back-standalone" onClick={() => { setGroupView('main'); setGroupErr(''); }}>← 설정</button>
      <div className="st-group-form">
        <h2 className="st-form-title">그룹 만들기</h2>
        <div className="st-code-card">
          <span className="st-code-card-label">그룹 코드</span>
          <span className="st-code-val">{createdCode}</span>
          <button className="st-copy-btn" onClick={() => copyCode(createdCode)}>
            {codeCopied ? '복사됨' : '복사'}
          </button>
        </div>
        <p className="st-hint">이 코드를 팀원에게 공유하면 같은 그룹으로 묶여요</p>
        <div className="st-field">
          <label className="st-label">그룹 이름 <span className="st-optional">선택</span></label>
          <input className="st-input" placeholder="예: 개발팀, 스트레칭 동료" value={groupNameInput}
            onChange={e => setGroupNameInput(e.target.value)} maxLength={20} />
        </div>
        <div className="st-field">
          <label className="st-label">내 닉네임 <span className="st-optional">모든 그룹 공통</span></label>
          <input className="st-input" placeholder="예: 혜미" value={nickname}
            onChange={e => setNickname(e.target.value)} maxLength={12} />
        </div>
        {groupErr && <p className="st-error">{groupErr}</p>}
        <button className="st-submit-btn" disabled={!nickname.trim() || groupLoad}
          onClick={() => addGroup(createdCode, nickname.trim(), groupNameInput.trim())}>
          {groupLoad ? '생성 중...' : '그룹 시작하기'}
        </button>
      </div>
    </div>
  );

  // ── 그룹 참여하기 서브뷰 ─────────────────────────────────────────────────────
  if (groupView === 'join') return (
    <div className="settings-root">
      <button className="st-back st-back-standalone" onClick={() => { setGroupView('main'); setGroupErr(''); }}>← 설정</button>
      <div className="st-group-form">
        <h2 className="st-form-title">그룹 참여하기</h2>
        <div className="st-field">
          <label className="st-label">그룹 코드</label>
          <input className="st-input st-input-mono" placeholder="6자리 코드" value={codeInput}
            onChange={e => setCodeInput(e.target.value.toUpperCase())} maxLength={6} />
        </div>
        <div className="st-field">
          <label className="st-label">내 닉네임 <span className="st-optional">모든 그룹 공통</span></label>
          <input className="st-input" placeholder="예: 혜미" value={nickname}
            onChange={e => setNickname(e.target.value)} maxLength={12} />
        </div>
        {groupErr && <p className="st-error">{groupErr}</p>}
        <button className="st-submit-btn"
          disabled={codeInput.length !== 6 || !nickname.trim() || groupLoad}
          onClick={() => joinGroup(codeInput, nickname.trim())}>
          {groupLoad ? '참여 중...' : '참여하기'}
        </button>
      </div>
    </div>
  );

  // ── 메인 설정 ─────────────────────────────────────────────────────────────────
  return (
    <div className="settings-root">

      <div className="st-header">
        <button className="st-back" onClick={onBack}>← 대시보드</button>
        <div className="st-header-brand">
          <div className="st-header-bell-box">
            <svg width="13" height="13" viewBox="0 0 24 24">
              <rect x="10.5" y="0" width="3" height="3.5" rx="1.5" fill="#fff"/>
              <path d="M12 3.5 C16.5 3.5,21 7.5,21 13 L21 17 L3 17 L3 13 C3 7.5,7.5 3.5,12 3.5 Z" fill="#fff"/>
              <rect x="2" y="16.5" width="20" height="2.5" rx="1.25" fill="#fff"/>
              <circle cx="12" cy="21.5" r="1.5" fill="#fff"/>
            </svg>
          </div>
          <span className="st-header-title">설정</span>
        </div>
      </div>

      <div className="st-scroll">

        {/* ── 알림 설정 ── */}
        <div className="st-block">
          <p className="st-block-label">알림 설정</p>

          <section className="card">
            <div className="section-label">가동 요일</div>
            <div className="day-row">
              {DAYS.map((name, idx) => (
                <button key={idx}
                  className={`day-btn ${local.activeDays.includes(idx) ? 'on' : ''}`}
                  onClick={() => toggleDay(idx)}>{name}</button>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="section-label">가동 시간</div>
            <div className="time-compact-row">
              <HourPicker label="시작" value={local.startHour} min={0} max={local.endHour - 1}
                onChange={v => update('startHour', v)} />
              <span className="time-sep">~</span>
              <HourPicker label="종료" value={local.endHour} min={local.startHour + 1} max={23}
                onChange={v => update('endHour', v)} />
            </div>
            {!isValid && <p className="field-error">시작 시각은 종료 시각보다 앞이어야 합니다</p>}
          </section>

          <section className="card">
            <div className="section-label">알림 주기</div>
            <div className="interval-stepper">
              <button className="interval-arrow"
                onClick={() => update('intervalMinutes', Math.max(INTERVAL_MIN, local.intervalMinutes - INTERVAL_STEP))}
                disabled={local.intervalMinutes <= INTERVAL_MIN}>‹</button>
              <div className="interval-display">
                <span className="interval-val">{formatMinutes(local.intervalMinutes)}</span>
                <span className="interval-hint">10분 단위 · 최대 4시간</span>
              </div>
              <button className="interval-arrow"
                onClick={() => update('intervalMinutes', Math.min(INTERVAL_MAX, local.intervalMinutes + INTERVAL_STEP))}
                disabled={local.intervalMinutes >= INTERVAL_MAX}>›</button>
            </div>
          </section>

          <section className="card">
            <div className="section-label">하루 목표 횟수</div>
            <div className="interval-stepper">
              <button className="interval-arrow"
                onClick={() => update('dailyGoal', Math.max(1, (local.dailyGoal ?? 8) - 1))}
                disabled={(local.dailyGoal ?? 8) <= 1}>‹</button>
              <div className="interval-display">
                <span className="interval-val">{local.dailyGoal ?? 8}회</span>
                <span className="interval-hint">팀 달성률 및 게이지 기준</span>
              </div>
              <button className="interval-arrow"
                onClick={() => update('dailyGoal', Math.min(24, (local.dailyGoal ?? 8) + 1))}
                disabled={(local.dailyGoal ?? 8) >= 24}>›</button>
            </div>
          </section>

          <button className={`save-btn state-${saveState}`} onClick={handleSave} disabled={!isValid}>
            {saveState === 'saved' ? '저장됨 ✓' : saveState === 'error' ? '오류 발생' : '저장하기'}
          </button>
        </div>

        <div className="st-sections-divider" />

        {/* ── 영양제 알림 ── */}
        <div className="st-block">
          <p className="st-block-label">영양제 알림</p>

          <section className="card">
            <div className="supp-toggle-row">
              <div>
                <div className="supp-toggle-title">영양제 알림 사용</div>
                <div className="supp-toggle-sub">설정한 시간에 복용 알림을 보내드려요</div>
              </div>
              <button
                className={`supp-toggle-btn${local.supplementsEnabled ? ' on' : ''}`}
                onClick={async () => {
                  const next = !local.supplementsEnabled;
                  const updated = await window.electronAPI.invoke('config:set', { supplementsEnabled: next });
                  onCfgChange(updated);
                  setLocal(p => ({ ...p, supplementsEnabled: next }));
                }}
              >{local.supplementsEnabled ? 'ON' : 'OFF'}</button>
            </div>
          </section>

          {local.supplementsEnabled && (
            <>
              {(local.supplements ?? []).length > 0 && (
                <div className="supp-list">
                  {(local.supplements ?? []).map(sup => (
                    editingSupId === sup.id ? (
                      <div key={sup.id} className="supp-add-form">
                        <input className="st-input" placeholder="영양제 이름"
                          value={editSuppName} onChange={e => setEditSuppName(e.target.value)}
                          maxLength={20} autoFocus />
                        <TimePicker value={editSuppTime} onChange={setEditSuppTime} />
                        <div className="supp-add-actions">
                          <button className="st-name-action save"
                            disabled={!editSuppName.trim()}
                            onClick={async () => {
                              const next = (local.supplements ?? []).map(s =>
                                s.id === sup.id ? { ...s, name: editSuppName.trim(), time: editSuppTime } : s
                              );
                              const updated = await window.electronAPI.invoke('config:set', { supplements: next });
                              onCfgChange(updated);
                              setLocal(p => ({ ...p, supplements: next }));
                              setEditingSupId(null);
                            }}>저장</button>
                          <button className="st-name-action cancel"
                            onClick={() => setEditingSupId(null)}>취소</button>
                        </div>
                      </div>
                    ) : (
                      <div key={sup.id} className="supp-item-row">
                        <svg className="supp-pill-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <path d="M10.5 3.5L3.5 10.5a5 5 0 0 0 7.07 7.07L17.5 10.5a5 5 0 0 0-7-7z"
                            stroke="#fdcb6e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          <line x1="8.5" y1="12.5" x2="15" y2="6"
                            stroke="#fdcb6e" strokeWidth="1.8" strokeLinecap="round"/>
                        </svg>
                        <div className="supp-item-info">
                          <span className="supp-item-name">{sup.name}</span>
                          <span className="supp-item-time">{formatTime12(sup.time)}</span>
                        </div>
                        <button className="st-name-edit-btn" style={{ marginRight: 4 }}
                          onClick={() => { setEditingSupId(sup.id); setEditSuppName(sup.name); setEditSuppTime(sup.time); setAddingSupp(false); }}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        <button className="st-leave-btn" style={{ fontSize: 13, padding: '6px 11px' }}
                          onClick={async () => {
                            const next = (local.supplements ?? []).filter(s => s.id !== sup.id);
                            const updated = await window.electronAPI.invoke('config:set', { supplements: next });
                            onCfgChange(updated);
                            setLocal(p => ({ ...p, supplements: next }));
                          }}>삭제</button>
                      </div>
                    )
                  ))}
                </div>
              )}

              {addingSupp ? (
                <div className="supp-add-form">
                  <input className="st-input" placeholder="영양제 이름 (예: 비타민C)"
                    value={suppName} onChange={e => setSuppName(e.target.value)}
                    maxLength={20} autoFocus />
                  <TimePicker value={suppTime} onChange={setSuppTime} />
                  <div className="supp-add-actions">
                    <button className="st-name-action save"
                      disabled={!suppName.trim()}
                      onClick={async () => {
                        const newSup = { id: Date.now().toString(), name: suppName.trim(), time: suppTime };
                        const next = [...(local.supplements ?? []), newSup];
                        const updated = await window.electronAPI.invoke('config:set', { supplements: next });
                        onCfgChange(updated);
                        setLocal(p => ({ ...p, supplements: next }));
                        setSuppName(''); setSuppTime('09:00'); setAddingSupp(false);
                      }}>추가</button>
                    <button className="st-name-action cancel"
                      onClick={() => { setSuppName(''); setSuppTime('09:00'); setAddingSupp(false); }}>취소</button>
                  </div>
                </div>
              ) : (
                <button className="supp-add-btn"
                  onClick={() => { setAddingSupp(true); setEditingSupId(null); }}>
                  <span>+</span> 영양제 추가
                </button>
              )}
            </>
          )}
        </div>

        <div className="st-sections-divider" />

        {/* ── 그룹 ── */}
        <div className="st-block">
          <p className="st-block-label">그룹</p>

          {/* 닉네임 (그룹이 하나라도 있을 때 표시) */}
          {currentGroups.length > 0 && (
            <div className="st-nick-section">
              {editingNick ? (
                <div className="st-name-edit-wrap">
                  <input className="st-input st-input-nick" autoFocus
                    value={nickDraft} onChange={e => setNickDraft(e.target.value)}
                    maxLength={12} placeholder="닉네임" />
                  <button className="st-name-action save" onClick={saveNickname}
                    disabled={groupLoad || !nickDraft.trim()}>저장</button>
                  <button className="st-name-action cancel" onClick={() => setEditingNick(false)}>취소</button>
                </div>
              ) : (
                <div className="st-nick-row">
                  <span className="st-nick-label">내 닉네임</span>
                  <span className="st-nick-value">{local.nickname}</span>
                  <button className="st-name-edit-btn" onClick={() => {
                    setNickDraft(local.nickname || ''); setEditingNick(true);
                  }} aria-label="닉네임 수정">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 그룹 목록 */}
          {currentGroups.length > 0 && (
            <div className="st-group-list">
              {currentGroups.map(g => (
                <div key={g.groupCode} className="st-group-item">
                  <div className="st-group-item-info">
                    <div className="st-group-item-name-row">
                      <span className="st-active-dot" />
                      <span className="st-group-item-name">{g.groupName || g.groupCode}</span>
                    </div>
                    <span className="st-group-item-code">{g.groupCode}</span>
                  </div>
                  <button
                    className="st-leave-btn"
                    onClick={() => leaveGroup(g.groupCode)}
                    disabled={leavingCode === g.groupCode}
                  >
                    {leavingCode === g.groupCode ? '처리 중...' : '나가기'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {groupErr && <p className="st-error">{groupErr}</p>}

          {/* 그룹 추가 메뉴 */}
          <div className="st-group-menu">
            <button className="st-group-menu-row" onClick={() => {
              setCreatedCode(generateCode());
              setNickname(local.nickname || '');
              setGroupNameInput('');
              setGroupErr('');
              setGroupView('create');
            }}>
              <div className="st-group-menu-icon create">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
                </svg>
              </div>
              <div className="st-group-menu-text">
                <span className="st-group-menu-title">새 그룹 만들기</span>
                <span className="st-group-menu-sub">코드를 생성해 팀원을 초대해요</span>
              </div>
              <svg className="st-group-menu-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <div className="st-group-menu-divider" />
            <button className="st-group-menu-row" onClick={() => {
              setCodeInput('');
              setNickname(local.nickname || '');
              setGroupErr('');
              setGroupView('join');
            }}>
              <div className="st-group-menu-icon join">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2"/>
                  <path d="M19 8v6M22 11h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </div>
              <div className="st-group-menu-text">
                <span className="st-group-menu-title">기존 그룹 참여하기</span>
                <span className="st-group-menu-sub">초대 코드를 입력해 합류해요</span>
              </div>
              <svg className="st-group-menu-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
