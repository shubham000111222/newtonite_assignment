import React, { useEffect, useState, useRef } from 'react';
import { Routes, Route, useNavigate, useLocation, Link } from 'react-router-dom';
import { LayoutDashboard, List, LogOut, AlertCircle, Plus, Loader2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const api = async (url: string, options: RequestInit = {}) => {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error?.message || 'API request failed', { cause: { status: res.status, ...error } });
  }
  return res.json();
};

function useIdempotentMutation<TData, TVariables>(
  mutationFn: (vars: TVariables & { idempotencyKey: string }) => Promise<TData>,
  options?: any
) {
  const idempotencyKey = useRef(crypto.randomUUID());

  return useMutation({
    mutationFn: (vars: TVariables) => mutationFn({ ...vars, idempotencyKey: idempotencyKey.current }),
    ...options,
    onSuccess: (...args) => {
      idempotencyKey.current = crypto.randomUUID();
      if (options?.onSuccess) options.onSuccess(...args);
    }
  });
}

function Toast({ message, onClose }: { message: string, onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 5000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className="toast">
      <AlertCircle size={20} />
      <span>{message}</span>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center p-8 text-muted gap-2">
      <Loader2 className="animate-spin" size={24} /> Loading...
    </div>
  );
}

function ErrorMessage({ error, retry }: { error: Error, retry?: () => void }) {
  return (
    <div className="p-8 text-danger flex-col items-center gap-4 text-center">
      <AlertCircle size={32} />
      <div>{error.message}</div>
      {retry && <button onClick={retry}>Retry</button>}
    </div>
  );
}

function Login({ setToken }: { setToken: (t: string) => void }) {
  const [email, setEmail] = useState('user0@example.com');
  const [password, setPassword] = useState('password123');

  const loginMutation = useMutation({
    mutationFn: () => api('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    }),
    onSuccess: (data) => {
      localStorage.setItem('token', data.token);
      setToken(data.token);
    }
  });

  return (
    <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={(e) => { e.preventDefault(); loginMutation.mutate(); }} className="card flex-col gap-6" style={{ width: 420 }}>
        <div>
          <h2 className="text-2xl" style={{ color: 'var(--primary-hover)' }}>Newtonite</h2>
          <p className="text-muted mt-2">Sign in to your workspace</p>
        </div>
        {loginMutation.error && (
          <div style={{ color: 'var(--danger)', padding: '12px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '6px', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
            {loginMutation.error.message}
          </div>
        )}
        <div className="flex-col gap-2">
          <label className="text-sm text-muted">Email</label>
          <input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} disabled={loginMutation.isPending} />
        </div>
        <div className="flex-col gap-2">
          <label className="text-sm text-muted">Password</label>
          <input placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} disabled={loginMutation.isPending} />
        </div>
        <button type="submit" disabled={loginMutation.isPending} style={{ marginTop: '8px', padding: '12px' }}>
          {loginMutation.isPending ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}

function Dashboard({ teamId }: { teamId: string }) {
  const { data: stats, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', teamId],
    queryFn: () => api(`/api/v1/dashboard?team_id=${teamId}`)
  });

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} retry={refetch} />;

  return (
    <div>
      <h1 className="text-2xl mb-8">Dashboard Overview</h1>
      <div className="flex gap-6">
        <div className="card card-hoverable" style={{ flex: 1 }}>
          <div className="text-muted mb-2 text-sm uppercase tracking-wider">Assigned to me</div>
          <div className="text-2xl" style={{ fontSize: '3rem' }}>{stats.assignedToMe}</div>
        </div>
        <div className="card card-hoverable" style={{ flex: 1 }}>
          <div className="text-muted mb-2 text-sm uppercase tracking-wider">Awaiting Approval</div>
          <div className="text-2xl" style={{ fontSize: '3rem', color: 'var(--primary-hover)' }}>{stats.awaitingApproval}</div>
        </div>
        <div className="card card-hoverable" style={{ flex: 1, border: '1px solid rgba(239, 68, 68, 0.3)' }}>
          <div className="text-muted mb-2 text-sm uppercase tracking-wider">Unassigned Urgent</div>
          <div className="text-2xl flex items-center gap-2" style={{ fontSize: '3rem', color: 'var(--danger-hover)' }}>
            <AlertCircle size={32} />
            {stats.unassignedUrgent}
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkItemsList({ teamId }: { teamId: string }) {
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [toastMsg, setToastMsg] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['work-items', teamId],
    queryFn: () => api(`/api/v1/work-items?team_id=${teamId}`)
  });

  const createMutation = useIdempotentMutation({
    mutationFn: (vars: any) => api('/api/v1/work-items', {
      method: 'POST',
      headers: { 'Idempotency-Key': vars.idempotencyKey },
      body: JSON.stringify({
        team_id: teamId,
        title: newTitle,
        description: newDesc,
        type: 'task',
        priority: 'medium'
      })
    }),
    onSuccess: () => {
      setIsCreating(false);
      setNewTitle('');
      setNewDesc('');
      queryClient.invalidateQueries({ queryKey: ['work-items', teamId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', teamId] });
    },
    onError: (err: any) => setToastMsg(err.message)
  });

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} retry={refetch} />;

  const items = data.items || [];

  return (
    <div>
      {toastMsg && <Toast message={toastMsg} onClose={() => setToastMsg('')} />}
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl">Work Items</h1>
        <button className="flex items-center gap-2" onClick={() => setIsCreating(true)}>
          <Plus size={16} /> New Item
        </button>
      </div>

      {isCreating && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <form className="card flex-col gap-4" style={{ width: 500 }} onSubmit={(e) => { e.preventDefault(); createMutation.mutate({}); }}>
            <h2 className="text-xl">Create New Item</h2>
            <div className="flex-col gap-2">
              <label className="text-sm text-muted">Title</label>
              <input required value={newTitle} onChange={e => setNewTitle(e.target.value)} disabled={createMutation.isPending} placeholder="E.g., Update database credentials" />
            </div>
            <div className="flex-col gap-2">
              <label className="text-sm text-muted">Description</label>
              <textarea required value={newDesc} onChange={e => setNewDesc(e.target.value)} disabled={createMutation.isPending} rows={4} placeholder="Detailed description..." />
            </div>
            <div className="flex gap-4 mt-4" style={{ justifyContent: 'flex-end' }}>
              <button type="button" disabled={createMutation.isPending} onClick={() => setIsCreating(false)} style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>Cancel</button>
              <button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Creating...' : 'Create Item'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Priority</th>
              <th style={{ textAlign: 'right' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item: any) => (
              <tr key={item.id}>
                <td style={{ fontWeight: 500 }}><Link to={`/items/${item.id}`}>{item.title}</Link></td>
                <td><span className={`badge ${item.status}`}>{item.status.replace('_', ' ')}</span></td>
                <td><span className={`badge ${item.priority === 'urgent' ? 'urgent' : ''}`}>{item.priority}</span></td>
                <td style={{ textAlign: 'right' }}>
                  <Link to={`/items/${item.id}`} style={{ fontSize: '0.875rem' }}>View →</Link>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', padding: '48px', color: 'var(--text-muted)' }}>
                  No work items found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WorkItemDetail() {
  const queryClient = useQueryClient();
  const id = useLocation().pathname.split('/').pop()!;
  const [toastMsg, setToastMsg] = useState('');

  const { data: item, isLoading, error, refetch } = useQuery({
    queryKey: ['work-item', id],
    queryFn: () => api(`/api/v1/work-items/${id}`)
  });

  const actionMutation = useIdempotentMutation({
    mutationFn: (vars: { url: string, body?: any, idempotencyKey: string }) => {
      const headers: any = { 'Idempotency-Key': vars.idempotencyKey };
      return api(vars.url, {
        method: 'POST',
        headers,
        body: vars.body ? JSON.stringify(vars.body) : undefined
      });
    },
    onSuccess: (newItem) => {
      queryClient.setQueryData(['work-item', id], newItem);
      queryClient.invalidateQueries({ queryKey: ['work-items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err: any) => {
      if (err.cause?.status === 409) {
        setToastMsg('Conflict detected! Changed by another user, please review.');
        queryClient.invalidateQueries({ queryKey: ['work-item', id] });
      } else {
        setToastMsg(err.message);
      }
    }
  });

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} retry={refetch} />;
  if (!item) return <div className="text-muted p-8 text-center">Item not found.</div>;

  const isPending = actionMutation.isPending;

  return (
    <div className="flex-col gap-6">
      {toastMsg && <Toast message={toastMsg} onClose={() => setToastMsg('')} />}
      <Link to="/items" className="text-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>← Back to list</Link>
      <div className="card">
        <h1 className="text-2xl">{item.title}</h1>
        <div className="flex gap-2 mt-4 mb-6">
          <span className={`badge ${item.status}`}>{item.status.replace('_', ' ')}</span>
          <span className={`badge ${item.priority === 'urgent' ? 'urgent' : ''}`}>{item.priority}</span>
          {item.requires_approval && <span className="badge">Requires Approval</span>}
        </div>
        <div className="text-muted mb-8" style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px' }}>
          {item.description}
        </div>
        
        <h3 className="text-sm text-muted uppercase tracking-wider mb-4">Available Actions</h3>
        <div className="flex gap-4 flex-wrap">
          {item.allowedActions.includes('claim') && (
            <button disabled={isPending} onClick={() => actionMutation.mutate({ url: `/api/v1/work-items/${id}/claim` })}>Claim Item</button>
          )}
          {item.allowedActions.includes('unassign') && (
            <button disabled={isPending} onClick={() => actionMutation.mutate({ url: `/api/v1/work-items/${id}/release` })}>Release Assignment</button>
          )}
          {item.allowedActions.includes('transition') && (
            <button disabled={isPending} onClick={() => actionMutation.mutate({ url: `/api/v1/work-items/${id}/transition`, body: { version: item.version, status: 'in_progress' } })}>Start Work</button>
          )}
          {item.allowedActions.includes('transition') && (
            <button disabled={isPending} onClick={() => actionMutation.mutate({ url: `/api/v1/work-items/${id}/transition`, body: { version: item.version, status: 'resolved' } })}>Mark Resolved</button>
          )}
          {item.allowedActions.includes('approve_reject') && (
            <button disabled={isPending} onClick={() => actionMutation.mutate({ url: `/api/v1/work-items/${id}/approve`, body: { version: item.version } })}>Approve Request</button>
          )}
          
          {item.allowedActions.length === 0 && <span className="text-muted text-sm">No actions available for your role/state.</span>}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const location = useLocation();
  const queryClient = useQueryClient();

  const { data: user, isLoading } = useQuery({
    queryKey: ['auth', token],
    queryFn: () => api('/api/v1/auth/me'),
    enabled: !!token,
    retry: false
  });

  useEffect(() => {
    if (!token) queryClient.clear();
  }, [token, queryClient]);

  if (!token) return <Login setToken={setToken} />;
  if (isLoading) return <div className="layout"><div className="content"><LoadingSpinner /></div></div>;
  if (!user) {
    localStorage.removeItem('token');
    setToken('');
    return null;
  }

  const teamId = Object.keys(user.user.memberships)[0];

  return (
    <div className="layout">
      <div className="sidebar">
        <div className="mb-6">
          <h2 className="text-xl" style={{ color: 'var(--primary-hover)', fontWeight: 700, letterSpacing: '-0.05em' }}>Newtonite</h2>
          <div className="text-sm text-muted mt-1">{user.user.name}</div>
        </div>
        <Link to="/" className={location.pathname === '/' ? 'active' : ''}><LayoutDashboard size={18} /> Dashboard</Link>
        <Link to="/items" className={location.pathname.startsWith('/items') ? 'active' : ''}><List size={18} /> Work Items</Link>
        <div style={{ flex: 1 }} />
        <button className="flex items-center gap-2" style={{ background: 'transparent', color: 'var(--danger-hover)', justifyContent: 'flex-start', border: 'none' }} onClick={() => { localStorage.removeItem('token'); setToken(''); }}>
          <LogOut size={18} /> Sign Out
        </button>
      </div>
      <div className="content">
        <Routes>
          <Route path="/" element={<Dashboard teamId={teamId} />} />
          <Route path="/items" element={<WorkItemsList teamId={teamId} />} />
          <Route path="/items/:id" element={<WorkItemDetail />} />
        </Routes>
      </div>
    </div>
  );
}
