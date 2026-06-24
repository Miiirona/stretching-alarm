import { useState } from 'react';
import { db } from './firebase.js';
import { doc, setDoc, getDoc, deleteDoc } from 'firebase/firestore';
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
  const [nickname,       setNickname]       = useState('');
  const [groupNameInput, setGroupNameInput] = useState('');
  const [codeInput,      setCodeInput]      = useState('');
  const [createdCode,    setCreatedCode]    = useState('');
  const [codeCopied,     setCodeCopied]     = useState(false);
  const [groupLoad,      setGroupLoad]      = useState(false);
  const [groupErr,       setGroupErr]       = useState('');
  const [editingName,    setEditingName]    = useState(false);
  const [nameDraft,      setNameDraft]      = useState('');

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

  async function saveGroup(groupCode, nick, gName = '') {
    setGroupLoad(true); setGroupErr('');
    try {
      if (gName) await setDoc(doc(db, 'groups', groupCode), { groupName: gName });
      await setDoc(doc(db, 'users', local.userId), { groupCode, nickname: nick });
      const updated = await window.electronAPI.invoke('config:set', {
        groupCode, nickname: nick, groupName: gName || null, pendingLogs: [],
      });
      onCfgChange(updated);
      setLocal(p => ({ ...p, groupCode, nickname: nick, groupName: gName || null }));
      setGroupView('main');
    } catch { setGroupErr('저장에 실패했어요. Firebase 설정을 확인해주세요.'); }
    finally { setGroupLoad(false); }
  }

  async function joinGroup(code, nick) {
    setGroupLoad(true); setGroupErr('');
    try {
      const groupDoc = await getDoc(doc(db, 'groups', code));
      const gName = groupDoc.exists() ? (groupDoc.data().groupName || null) : null;
      await setDoc(doc(db, 'users', local.userId), { groupCode: code, nickname: nick });
      const updated = await window.electronAPI.invoke('config:set', {
        groupCode: code, nickname: nick, groupName: gName, pendingLogs: [],
      });
      onCfgChange(updated);
      setLocal(p => ({ ...p, groupCode: code, nickname: nick, groupName: gName }));
      setGroupView('main');
    } catch { setGroupErr('저장에 실패했어요. 그룹 코드를 확인해주세요.'); }
    finally { setGroupLoad(false); }
  }

  async function saveGroupName() {
    setGroupLoad(true); setGroupErr('');
    try {
      const name = nameDraft.trim();
      await setDoc(doc(db, 'groups', local.groupCode), { groupName: name }, { merge: true });
      const updated = await window.electronAPI.invoke('config:set', { groupName: name || null });
      onCfgChange(updated);
      setLocal(p => ({ ...p, groupName: name || null }));
      setEditingName(false);
    } catch { setGroupErr('이름 저장에 실패했어요.'); }
    finally { setGroupLoad(false); }
  }

  async function leaveGroup() {
    setGroupLoad(true); setGroupErr('');
    try {
      await deleteDoc(doc(db, 'users', local.userId));
      const updated = await window.electronAPI.invoke('config:set', {
        groupCode: null, nickname: null, groupName: null, pendingLogs: [],
      });
      onCfgChange(updated);
      setLocal(p => ({ ...p, groupCode: null, nickname: null, groupName: null }));
    } catch { setGroupErr('그룹 나가기에 실패했어요.'); }
    finally { setGroupLoad(false); }
  }

  function copyCode(code) {
    navigator.clipboard.writeText(code);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  }

  // ── 그룹 만들기 ──────────────────────────────────────────────────────────────
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
          <label className="st-label">내 닉네임</label>
          <input className="st-input" placeholder="예: 혜미" value={nickname}
            onChange={e => setNickname(e.target.value)} maxLength={12} />
        </div>
        {groupErr && <p className="st-error">{groupErr}</p>}
        <button className="st-submit-btn" disabled={!nickname.trim() || groupLoad}
          onClick={() => saveGroup(createdCode, nickname.trim(), groupNameInput.trim())}>
          {groupLoad ? '생성 중...' : '그룹 시작하기'}
        </button>
      </div>
    </div>
  );

  // ── 그룹 참여하기 ─────────────────────────────────────────────────────────────
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
          <label className="st-label">내 닉네임</label>
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

  // ── 메인 설정 ────────────────────────────────────────────────────────────────
  return (
    <div className="settings-root">

      <div className="st-header">
        <button className="st-back" onClick={onBack}>← 대시보드</button>
        <span className="st-header-title">설정</span>
      </div>

      <div className="st-scroll">

        {/* ── 앱 설정 영역 ── */}
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

        {/* ── 구분선 ── */}
        <div className="st-sections-divider" />

        {/* ── 그룹 영역 ── */}
        <div className="st-block">
          <p className="st-block-label">그룹</p>

          {local.groupCode ? (
            <div className="st-group-panel">
              {/* 상단: 이름 + 코드 + 닉네임 */}
              <div className="st-group-panel-body">
                <div className="st-group-panel-status">
                  <span className="st-active-dot" />
                  <span className="st-active-label">참여 중</span>
                </div>

                {editingName ? (
                  <div className="st-name-edit-wrap">
                    <input className="st-input st-input-name" autoFocus
                      value={nameDraft} onChange={e => setNameDraft(e.target.value)}
                      maxLength={20} placeholder="그룹 이름" />
                    <button className="st-name-action save" onClick={saveGroupName} disabled={groupLoad}>저장</button>
                    <button className="st-name-action cancel" onClick={() => setEditingName(false)}>취소</button>
                  </div>
                ) : (
                  <div className="st-group-name-row">
                    <span className="st-group-name-display">
                      {local.groupName || <span className="st-no-name">이름 없음</span>}
                    </span>
                    <button className="st-name-edit-btn" onClick={() => {
                      setNameDraft(local.groupName || '');
                      setEditingName(true);
                    }}>수정</button>
                  </div>
                )}

                <div className="st-group-meta">
                  <span className="st-group-code">{local.groupCode}</span>
                  <span className="st-group-nick-badge">{local.nickname}</span>
                </div>
              </div>

              {/* 하단: 나가기 */}
              <div className="st-group-panel-footer">
                {groupErr && <p className="st-error">{groupErr}</p>}
                <button className="st-leave-btn" onClick={leaveGroup} disabled={groupLoad}>
                  {groupLoad ? '처리 중...' : '그룹 나가기'}
                </button>
              </div>
            </div>
          ) : (
            <div className="st-group-menu">
              <button className="st-group-menu-row" onClick={() => {
                setCreatedCode(generateCode()); setNickname(''); setGroupNameInput(''); setGroupErr(''); setGroupView('create');
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
                setCodeInput(''); setNickname(''); setGroupErr(''); setGroupView('join');
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
          )}
        </div>

      </div>
    </div>
  );
}
