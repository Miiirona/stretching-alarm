import { useState, useEffect, useCallback } from 'react';
import { db } from './firebase.js';
import {
  doc, setDoc, getDocs, deleteDoc, writeBatch,
  collection, query, where,
} from 'firebase/firestore';
import './GroupView.css';

const DAILY_GOAL = 8;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function weekStartStr() {
  const d = new Date();
  const diff = d.getDay() === 0 ? -6 : 1 - d.getDay(); // Monday
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  return mon.toISOString().slice(0, 10);
}

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export default function GroupView() {
  const [cfg, setCfg]             = useState(null);
  const [view, setView]           = useState('loading');
  const [nickname, setNickname]   = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [createdCode, setCreatedCode] = useState('');
  const [members, setMembers]     = useState([]);
  const [statsMode, setStatsMode] = useState('today');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [codeCopied, setCodeCopied] = useState(false);

  useEffect(() => {
    window.electronAPI?.invoke('config:get').then(c => {
      setCfg(c);
      setView(c?.groupCode ? 'dashboard' : 'home');
    });
  }, []);

  const fetchMembers = useCallback(async (groupCode, userId, dailyCount, pendingLogs, nick, mode) => {
    setLoading(true);
    setError('');
    try {
      // 1. 미동기화 완료 로그를 Firestore에 일괄 저장
      if (pendingLogs?.length > 0) {
        const batch = writeBatch(db);
        for (const log of pendingLogs) {
          const ref = doc(collection(db, 'stretching_logs'));
          batch.set(ref, {
            userId,
            groupCode,
            date: log.completedAt.slice(0, 10),
            completedAt: log.completedAt,
          });
        }
        await batch.commit();
        await window.electronAPI.invoke('config:set', { pendingLogs: [] });
        setCfg(prev => prev ? { ...prev, pendingLogs: [] } : prev);
      }

      // 2. 그룹 내 전체 사용자 목록 조회
      const usersSnap = await getDocs(
        query(collection(db, 'users'), where('groupCode', '==', groupCode))
      );
      const userMap = {};
      usersSnap.forEach(d => { userMap[d.id] = d.data().nickname; });
      userMap[userId] = nick; // 본인 보장

      // 3. 기간 내 완료 로그 조회 (오늘 or 이번 주 월요일~오늘)
      const dateFrom = mode === 'week' ? weekStartStr() : todayStr();
      const logsSnap = await getDocs(
        query(
          collection(db, 'stretching_logs'),
          where('groupCode', '==', groupCode),
          where('date', '>=', dateFrom),
        )
      );

      // 4. 사용자별 횟수 집계
      const counts = {};
      logsSnap.forEach(d => {
        const uid = d.data().userId;
        counts[uid] = (counts[uid] || 0) + 1;
      });

      // 5. 아직 Firestore에 없는 본인 횟수는 로컬 dailyCount 로 보완 (오늘 탭만)
      if (mode === 'today' && !counts[userId]) {
        counts[userId] = dailyCount ?? 0;
      }

      const list = Object.entries(userMap).map(([uid, n]) => ({
        userId: uid,
        nickname: n,
        count: counts[uid] || 0,
        isMe: uid === userId,
      }));
      list.sort((a, b) => b.count - a.count || (a.isMe ? -1 : 1));
      setMembers(list);
    } catch (e) {
      console.error('[Group]', e);
      setError('데이터를 불러오지 못했어요. Firebase 설정을 확인해주세요.');
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback((mode) => {
    window.electronAPI?.invoke('config:get').then(c => {
      if (!c?.groupCode) return;
      setCfg(c);
      fetchMembers(c.groupCode, c.userId, c.dailyCount ?? 0, c.pendingLogs ?? [], c.nickname, mode ?? statsMode);
    });
  }, [fetchMembers, statsMode]);

  useEffect(() => {
    if (view === 'dashboard') refresh(statsMode);
  }, [view, statsMode]); // eslint-disable-line

  async function saveGroup(groupCode, nick) {
    setLoading(true);
    setError('');
    try {
      // 그룹 변경 시 미동기화 로그 초기화
      const updated = await window.electronAPI.invoke('config:set', {
        groupCode, nickname: nick, pendingLogs: [],
      });
      await setDoc(doc(db, 'users', cfg.userId), { groupCode, nickname: nick });
      setCfg({ ...cfg, ...updated, groupCode, nickname: nick, pendingLogs: [] });
      setView('dashboard');
    } catch (e) {
      console.error('[Group]', e);
      setError('저장에 실패했어요. Firebase 설정을 확인해주세요.');
    } finally {
      setLoading(false);
    }
  }

  async function leaveGroup() {
    setLoading(true);
    try {
      await deleteDoc(doc(db, 'users', cfg.userId));
      const updated = await window.electronAPI.invoke('config:set', {
        groupCode: null, nickname: null, pendingLogs: [],
      });
      setCfg({ ...cfg, ...updated, groupCode: null, nickname: null });
      setMembers([]);
      setView('home');
    } catch (e) {
      setError('그룹 나가기에 실패했어요.');
    } finally {
      setLoading(false);
    }
  }

  function copyCode(code) {
    navigator.clipboard.writeText(code);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  }

  // ── 로딩 ──────────────────────────────────────────────────────────────────
  if (view === 'loading' || !cfg) {
    return <div className="g-center g-muted">불러오는 중...</div>;
  }

  // ── 홈 ────────────────────────────────────────────────────────────────────
  if (view === 'home') return (
    <div className="g-root">
      <div className="g-hero">
        <div className="g-hero-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="#00B894" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="9" cy="7" r="4" stroke="#00B894" strokeWidth="2"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="#00B894" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </div>
        <p className="g-hero-title">그룹 현황판</p>
        <p className="g-hero-desc">팀원들과 스트레칭 현황을 공유해요</p>
      </div>
      <div className="g-home-btns">
        <button className="g-btn-primary" onClick={() => {
          setCreatedCode(generateCode());
          setNickname('');
          setError('');
          setView('create');
        }}>그룹 만들기</button>
        <button className="g-btn-secondary" onClick={() => {
          setCodeInput('');
          setNickname('');
          setError('');
          setView('join');
        }}>그룹 참여하기</button>
      </div>
    </div>
  );

  // ── 그룹 만들기 ────────────────────────────────────────────────────────────
  if (view === 'create') return (
    <div className="g-root">
      <button className="g-back" onClick={() => { setView('home'); setError(''); }}>← 돌아가기</button>
      <h2 className="g-form-title">그룹 만들기</h2>

      <div className="g-code-card">
        <span className="g-code-card-label">그룹 코드</span>
        <span className="g-code-card-val">{createdCode}</span>
        <button className="g-copy-btn" onClick={() => copyCode(createdCode)}>
          {codeCopied ? '복사됨' : '복사'}
        </button>
      </div>
      <p className="g-hint">이 코드를 팀원에게 공유하면 같은 그룹으로 묶여요</p>

      <div className="g-field">
        <label className="g-label">내 닉네임</label>
        <input className="g-input" placeholder="예: 혜미" value={nickname}
          onChange={e => setNickname(e.target.value)} maxLength={12} />
      </div>

      {error && <p className="g-error">{error}</p>}
      <button className="g-btn-primary" disabled={!nickname.trim() || loading}
        onClick={() => saveGroup(createdCode, nickname.trim())}>
        {loading ? '생성 중...' : '그룹 시작하기'}
      </button>
    </div>
  );

  // ── 그룹 참여하기 ──────────────────────────────────────────────────────────
  if (view === 'join') return (
    <div className="g-root">
      <button className="g-back" onClick={() => { setView('home'); setError(''); }}>← 돌아가기</button>
      <h2 className="g-form-title">그룹 참여하기</h2>

      <div className="g-field">
        <label className="g-label">그룹 코드</label>
        <input className="g-input g-input-mono" placeholder="6자리 코드" value={codeInput}
          onChange={e => setCodeInput(e.target.value.toUpperCase())} maxLength={6} />
      </div>
      <div className="g-field">
        <label className="g-label">내 닉네임</label>
        <input className="g-input" placeholder="예: 혜미" value={nickname}
          onChange={e => setNickname(e.target.value)} maxLength={12} />
      </div>

      {error && <p className="g-error">{error}</p>}
      <button className="g-btn-primary"
        disabled={codeInput.length !== 6 || !nickname.trim() || loading}
        onClick={() => saveGroup(codeInput, nickname.trim())}>
        {loading ? '참여 중...' : '참여하기'}
      </button>
    </div>
  );

  // ── 대시보드 ───────────────────────────────────────────────────────────────
  const totalGoal  = members.length * DAILY_GOAL;
  const totalCount = members.reduce((s, m) => s + m.count, 0);
  const teamPct    = totalGoal > 0 ? Math.min(100, Math.round((totalCount / totalGoal) * 100)) : 0;

  return (
    <div className="g-root g-dashboard">

      {/* 상단 코드 바 */}
      <div className="g-code-bar">
        <span className="g-code-bar-label">그룹</span>
        <span className="g-code-bar-val">{cfg.groupCode}</span>
        <button className="g-copy-btn sm" onClick={() => copyCode(cfg.groupCode)}>
          {codeCopied ? '복사됨' : '복사'}
        </button>
        <span className="g-nick-badge">{cfg.nickname}</span>
      </div>

      {/* 기간 토글 + 새로고침 */}
      <div className="g-toolbar">
        <div className="g-toggle">
          <button className={`g-toggle-btn ${statsMode === 'today' ? 'on' : ''}`}
            onClick={() => setStatsMode('today')}>오늘</button>
          <button className={`g-toggle-btn ${statsMode === 'week' ? 'on' : ''}`}
            onClick={() => setStatsMode('week')}>이번 주</button>
        </div>
        <button className="g-refresh" onClick={() => refresh()} disabled={loading}>
          {loading ? '...' : '새로고침'}
        </button>
      </div>

      {/* 팀 달성률 */}
      {!loading && members.length > 0 && (
        <div className="g-team-gauge">
          <div className="g-team-gauge-header">
            <span className="g-team-gauge-label">팀 달성률</span>
            <span className="g-team-gauge-pct">{teamPct}%
              <span className="g-team-gauge-detail"> ({totalCount} / {totalGoal}회)</span>
            </span>
          </div>
          <div className="g-team-gauge-track">
            <div className="g-team-gauge-fill" style={{ width: `${teamPct}%` }} />
          </div>
        </div>
      )}

      {/* 멤버 리스트 */}
      <div className="g-list-area">
        {error ? (
          <p className="g-error">{error}</p>
        ) : loading ? (
          <div className="g-center g-muted">불러오는 중...</div>
        ) : members.length === 0 ? (
          <div className="g-center g-muted">아직 완료 기록이 없어요</div>
        ) : members.map((m, i) => {
          const rank = i + 1;
          const pct  = Math.min(100, totalCount > 0 ? Math.round((m.count / Math.max(...members.map(x => x.count))) * 100) : 0);
          return (
            <div key={m.userId} className={`g-member ${m.isMe ? 'me' : ''}`}>
              <span className={`g-rank r${Math.min(rank, 4)}`}>{rank}</span>
              <div className="g-member-body">
                <div className="g-member-top">
                  <span className="g-member-name">{m.nickname}{m.isMe ? <span className="g-me-tag"> 나</span> : ''}</span>
                  <span className="g-member-cnt">{m.count}회</span>
                </div>
                <div className="g-bar-track">
                  <div className="g-bar-fill" style={{ width: `${pct}%`, opacity: m.count === 0 ? 0 : 1 }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 그룹 나가기 */}
      <button className="g-leave" onClick={leaveGroup} disabled={loading}>
        그룹 나가기
      </button>
    </div>
  );
}
