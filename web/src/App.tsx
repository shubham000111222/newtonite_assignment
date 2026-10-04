import React, { useEffect, useState, useRef, Fragment } from 'react';
import { Routes, Route, useNavigate, useLocation, Link, useSearchParams } from 'react-router-dom';
import { LayoutDashboard, List, LogOut, AlertCircle, Plus, Loader2, Search, Filter } from 'lucide-react';
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';

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

function formatRelativeTime(dateStr: string) {
  if (!dateStr) return '';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const daysDifference = Math.round((new Date(dateStr).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
  return rtf.format(daysDifference, 'day');
}

function ClaimButton({ itemId, onClaimed, onError }: { itemId: string, onClaimed: () => void, onError: (msg: string) => void }) {
  const claimMutation = useIdempotentMutation({
    mutationFn: (vars: any) => api(`/api/v1/work-items/${itemId}/claim`, {
      method: 'POST',
      headers: { 'Idempotency-Key': vars.idempotencyKey }
    }),
    onSuccess: onClaimed,
    onError: (err: any) => {
      if (err.cause?.status === 409 && err.cause?.item) {
        const owner = err.cause.item.assignee_id || 'someone else';
        onError(`Conflict! Claimed by ${owner.substring(0,8)}...`);
      } else {
        onError(err.message);
      }
    }
  });

  return (
    <button 
      style={{ padding: '4px 8px', fontSize: '0.75rem', marginLeft: '8px' }} 
      disabled={claimMutation.isPending} 
      onClick={(e) => { e.preventDefault(); claimMutation.mutate({}); }}
    >
      {claimMutation.isPending ? '...' : 'Claim'}
    </button>
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
      localStorage.removeItem('team_id');
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

function Dashboard({ teamId, userId }: { teamId: string, userId: string }) {
  const { data: stats, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', teamId],
    queryFn: () => api(`/api/v1/dashboard?team_id=${teamId}`)
  });

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} retry={refetch} />;

  return (
    <div>
      <h1 className="text-2xl mb-8">Dashboard Overview</h1>
      <div className="flex gap-6 mb-6">
        <Link to={`/items?assignee_id=${userId}`} className="card card-hoverable" style={{ flex: 1, textDecoration: 'none', color: 'inherit' }}>
          <div className="text-muted mb-2 text-sm uppercase tracking-wider">Assigned to me</div>
          <div className="text-2xl" style={{ fontSize: '3rem' }}>{stats.assignedToMe}</div>
        </Link>
        <Link to={`/items?status=new`} className="card card-hoverable" style={{ flex: 1, textDecoration: 'none', color: 'inherit' }}>
          <div className="text-muted mb-2 text-sm uppercase tracking-wider">Awaiting Approval</div>
          <div className="text-2xl" style={{ fontSize: '3rem', color: 'var(--primary-hover)' }}>{stats.awaitingApproval}</div>
        </Link>
        <Link to={`/items?priority=urgent`} className="card card-hoverable" style={{ flex: 1, border: '1px solid rgba(239, 68, 68, 0.3)', textDecoration: 'none', color: 'inherit' }}>
          <div className="text-muted mb-2 text-sm uppercase tracking-wider">Unassigned Urgent</div>
          <div className="text-2xl flex items-center gap-2" style={{ fontSize: '3rem', color: 'var(--danger-hover)' }}>
            <AlertCircle size={32} />
            {stats.unassignedUrgent}
          </div>
        </Link>
      </div>
      <div className="flex gap-6">
        <Link to={`/items?overdue=true`} className="card card-hoverable" style={{ flex: 1, border: '1px solid rgba(245, 158, 11, 0.3)', textDecoration: 'none', color: 'inherit' }}>
          <div className="text-muted mb-2 text-sm uppercase tracking-wider">Stale / Overdue</div>
          <div className="text-2xl" style={{ fontSize: '3rem', color: 'var(--warning-hover, #F59E0B)' }}>{stats.overdueStale}</div>
        </Link>
        <Link to={`/items`} className="card card-hoverable" style={{ flex: 1, textDecoration: 'none', color: 'inherit' }}>
          <div className="text-muted mb-2 text-sm uppercase tracking-wider">Recently Changed</div>
          <div className="text-2xl" style={{ fontSize: '3rem', color: 'var(--success-hover, #10B981)' }}>{stats.recentlyChanged}</div>
        </Link>
      </div>
    </div>
  );
}

function WorkItemsList({ teamId, userId, userMemberships }: { teamId: string, userId: string, userMemberships: Record<string, string> }) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  
  const statusFilter = searchParams.get('status') || '';
  const priorityFilter = searchParams.get('priority') || '';
  const overdueFilter = searchParams.get('overdue') || '';
  const qFilter = searchParams.get('q') || '';
  const assigneeFilter = searchParams.get('assignee_id') || '';

  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [createTeamId, setCreateTeamId] = useState(teamId || Object.keys(userMemberships)[0] || '');
  const [toastMsg, setToastMsg] = useState('');

  const { 
    data, isLoading, error, refetch, 
    fetchNextPage, hasNextPage, isFetchingNextPage 
  } = useInfiniteQuery({
    queryKey: ['work-items', teamId, statusFilter, priorityFilter, overdueFilter, qFilter, assigneeFilter],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      p.set('team_id', teamId);
      if (statusFilter) p.set('status', statusFilter);
      if (priorityFilter) p.set('priority', priorityFilter);
      if (overdueFilter) p.set('overdue', overdueFilter);
      if (qFilter) p.set('q', qFilter);
      if (assigneeFilter) p.set('assignee_id', assigneeFilter);
      if (pageParam) p.set('cursor', pageParam);
      return api(`/api/v1/work-items?${p.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined
  });

  const createMutation = useIdempotentMutation({
    mutationFn: (vars: any) => api('/api/v1/work-items', {
      method: 'POST',
      headers: { 'Idempotency-Key': vars.idempotencyKey },
      body: JSON.stringify({
        team_id: createTeamId,
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

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  };

  return (
    <div>
      {toastMsg && <Toast message={toastMsg} onClose={() => setToastMsg('')} />}
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl">Work Items</h1>
        <button className="flex items-center gap-2" onClick={() => setIsCreating(true)}>
          <Plus size={16} /> New Item
        </button>
      </div>

      <div className="card mb-6 flex items-center gap-4 flex-wrap" style={{ padding: '16px 24px' }}>
        <div className="flex items-center gap-2" style={{ flex: 1, minWidth: 200, background: 'rgba(0,0,0,0.2)', padding: '0 12px', borderRadius: 8, border: '1px solid var(--panel-border)' }}>
          <Search size={16} className="text-muted" />
          <input 
            placeholder="Search titles and descriptions..." 
            value={qFilter} 
            onChange={e => setParam('q', e.target.value)} 
            style={{ border: 'none', background: 'transparent', boxShadow: 'none', flex: 1, padding: '12px 0' }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter size={16} className="text-muted" />
          <select value={assigneeFilter} onChange={e => setParam('assignee_id', e.target.value)}>
            <option value="">Any Assignee</option>
            <option value={userId}>Assigned to Me</option>
          </select>
          <select value={statusFilter} onChange={e => setParam('status', e.target.value)}>
            <option value="">All Statuses</option>
            <option value="new">New</option>
            <option value="triaged">Triaged</option>
            <option value="in_progress">In Progress</option>
            <option value="blocked">Blocked</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <select value={priorityFilter} onChange={e => setParam('priority', e.target.value)}>
            <option value="">All Priorities</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
          <select value={overdueFilter} onChange={e => setParam('overdue', e.target.value)}>
            <option value="">Any Timing</option>
            <option value="true">Overdue</option>
          </select>
        </div>
      </div>

      {isCreating && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <form className="card flex-col gap-4" style={{ width: 500 }} onSubmit={(e) => { e.preventDefault(); createMutation.mutate({}); }}>
            <h2 className="text-xl">Create New Item</h2>
            <div className="flex-col gap-2">
              <label className="text-sm text-muted">Team</label>
              <select required value={createTeamId} onChange={e => setCreateTeamId(e.target.value)} disabled={createMutation.isPending}>
                <option value="" disabled>Select a team</option>
                {Object.keys(userMemberships).map(id => (
                  <option key={id} value={id}>{id.substring(0,8)}</option>
                ))}
              </select>
            </div>
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
              <th>Assignee</th>
              <th>Updated</th>
              <th>Due</th>
              <th style={{ textAlign: 'right' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {data.pages.map((page, i) => (
              <React.Fragment key={i}>
                {page.items.map((item: any) => {
                  const isOverdue = item.due_at && new Date(item.due_at) < new Date() && !['resolved', 'closed'].includes(item.status);
                  return (
                    <tr key={item.id}>
                      <td style={{ fontWeight: 500 }}><Link to={`/items/${item.id}`}>{item.title}</Link></td>
                      <td><span className={`badge ${item.status}`}>{item.status.replace('_', ' ')}</span></td>
                      <td><span className={`badge ${item.priority}`}>{item.priority}</span></td>
                      <td>
                        {item.assignee_id ? (
                          <span className="text-muted">{item.assignee_id === userId ? 'Me' : (item.assignee_name || item.assignee_id.substring(0,8))}</span>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center' }}>
                            <span style={{ color: 'var(--danger)', fontWeight: 500 }}>Unassigned</span>
                            {item.allowedActions?.includes('claim') ? (
                              <ClaimButton 
                                itemId={item.id} 
                                onClaimed={() => queryClient.invalidateQueries({ queryKey: ['work-items'] })} 
                                onError={(msg) => setToastMsg(msg)} 
                              />
                            ) : (
                              item.actionReasons?.claim && (
                                <span style={{ fontSize: '0.75rem', marginLeft: '8px', color: 'var(--text-muted)' }}>
                                  ({item.actionReasons.claim})
                                </span>
                              )
                            )}
                          </div>
                        )}
                      </td>
                      <td className="text-muted" style={{ fontSize: '0.875rem' }}>{formatRelativeTime(item.updated_at)}</td>
                      <td style={{ fontSize: '0.875rem', color: isOverdue ? 'var(--danger)' : 'var(--text-muted)' }}>
                        {item.due_at ? new Date(item.due_at).toLocaleDateString() : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <Link to={`/items/${item.id}`} style={{ fontSize: '0.875rem' }}>View →</Link>
                      </td>
                    </tr>
                  );
                })}
              </React.Fragment>
            ))}
            {data.pages[0].items.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '48px', color: 'var(--text-muted)' }}>
                  No work items found matching filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {hasNextPage && (
        <div className="flex justify-center mt-6">
          <button 
            disabled={isFetchingNextPage} 
            onClick={() => fetchNextPage()} 
            style={{ background: 'transparent', border: '1px solid var(--panel-border)', color: 'var(--text-muted)' }}
          >
            {isFetchingNextPage ? 'Loading more...' : 'Load More'}
          </button>
        </div>
      )}
    </div>
  );
}

function WorkItemDetail() {
  const queryClient = useQueryClient();
  const id = useLocation().pathname.split('/').pop()!;
  const [toastMsg, setToastMsg] = useState('');

  // Main data, fetched once (unless manually invalidated)
  const { data: item, isLoading, error, refetch } = useQuery({
    queryKey: ['work-item', id],
    queryFn: () => api(`/api/v1/work-items/${id}`),
    staleTime: Infinity
  });

  // Background poller
  const { data: pollData } = useQuery({
    queryKey: ['work-item-poll', id],
    queryFn: () => api(`/api/v1/work-items/${id}`),
    refetchInterval: 20000,
    refetchOnWindowFocus: true
  });

  const hasNewVersion = item && pollData && pollData.version > item.version;

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
      queryClient.setQueryData(['work-item-poll', id], newItem);
      queryClient.invalidateQueries({ queryKey: ['work-items'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['work-item-events', id] });
    },
    onError: (err: any) => {
      if (err.cause?.status === 409) {
        setToastMsg('Conflict detected! Changed by another user, please review.');
        queryClient.invalidateQueries({ queryKey: ['work-item', id] });
        queryClient.invalidateQueries({ queryKey: ['work-item-poll', id] });
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
      {hasNewVersion && (
        <div style={{ background: 'var(--primary-hover)', color: '#fff', padding: '12px 16px', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Item was updated by another user.</span>
          <button style={{ background: 'rgba(0,0,0,0.2)', border: 'none', color: '#fff' }} onClick={() => {
            queryClient.setQueryData(['work-item', id], pollData);
            queryClient.invalidateQueries({ queryKey: ['work-item-events', id] });
            queryClient.invalidateQueries({ queryKey: ['work-item-comments', id] });
          }}>Refresh Now</button>
        </div>
      )}
      {toastMsg && <Toast message={toastMsg} onClose={() => setToastMsg('')} />}
      <Link to="/items" className="text-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>← Back to list</Link>
      <div className="card">
        <div className="flex justify-between items-start">
          <h1 className="text-2xl">{item.title}</h1>
          <div className="text-muted text-sm">Assignee: {item.assignee_id ? (item.assignee_id === userId ? 'Me' : item.assignee_name) : <span className="text-danger">Unassigned</span>}</div>
        </div>
        <div className="flex gap-2 mt-4 mb-6">
          <span className={`badge ${item.status}`}>{item.status.replace('_', ' ')}</span>
          <span className={`badge ${item.priority}`}>{item.priority}</span>
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

      <div className="flex gap-6" style={{ alignItems: 'flex-start' }}>
        <div className="card flex-col gap-4" style={{ flex: 1 }}>
          <h3 className="text-lg">Activity Timeline</h3>
          <ItemEvents id={id} />
        </div>
        <div className="card flex-col gap-4" style={{ flex: 1 }}>
          <h3 className="text-lg">Comments</h3>
          <ItemComments id={id} allowedActions={item.allowedActions} />
        </div>
      </div>
    </div>
  );
}

function ItemEvents({ id }: { id: string }) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['work-item-events', id],
    queryFn: ({ pageParam }) => api(`/api/v1/work-items/${id}/events${pageParam ? `?cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined
  });

  if (!data) return <div className="text-muted">Loading...</div>;

  return (
    <div className="flex-col gap-4">
      {data.pages.map((p, i) => (
        <React.Fragment key={i}>
          {p.items.map((ev: any) => (
            <div key={ev.id} className="text-sm" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '12px' }}>
              <div className="flex justify-between text-muted mb-1">
                <span>{ev.actor_id.substring(0,8)}</span>
                <span>{new Date(ev.created_at).toLocaleString()}</span>
              </div>
              <div style={{ color: 'var(--text)' }}>
                <strong>{ev.type.replace('_', ' ')}</strong>
                {ev.payload && Object.keys(ev.payload).length > 0 && (
                  <pre style={{ background: 'rgba(0,0,0,0.1)', padding: 8, marginTop: 4, borderRadius: 4, fontSize: '0.75rem' }}>
                    {JSON.stringify(ev.payload, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          ))}
        </React.Fragment>
      ))}
      {hasNextPage && (
        <button className="text-sm text-muted" onClick={() => fetchNextPage()} disabled={isFetchingNextPage} style={{ background: 'transparent', border: '1px solid var(--border)' }}>
          {isFetchingNextPage ? 'Loading...' : 'Older Events'}
        </button>
      )}
    </div>
  );
}

function ItemComments({ id, allowedActions }: { id: string, allowedActions: string[] }) {
  const queryClient = useQueryClient();
  const [newComment, setNewComment] = useState('');
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['work-item-comments', id],
    queryFn: ({ pageParam }) => api(`/api/v1/work-items/${id}/comments${pageParam ? `?cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined
  });

  const commentMutation = useIdempotentMutation({
    mutationFn: (vars: any) => api(`/api/v1/work-items/${id}/comments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': vars.idempotencyKey },
      body: JSON.stringify({ content: newComment })
    }),
    onSuccess: () => {
      setNewComment('');
      queryClient.invalidateQueries({ queryKey: ['work-item-comments', id] });
      queryClient.invalidateQueries({ queryKey: ['work-item-events', id] });
    }
  });

  return (
    <div className="flex-col gap-4">
      {data?.pages.map((p, i) => (
        <React.Fragment key={i}>
          {p.items.map((c: any) => (
            <div key={c.id} className="text-sm" style={{ background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: 8 }}>
              <div className="flex justify-between text-muted mb-2" style={{ fontSize: '0.75rem' }}>
                <span>{c.author_id.substring(0,8)}</span>
                <span>{new Date(c.created_at).toLocaleString()}</span>
              </div>
              <div style={{ color: 'var(--text)' }}>{c.content}</div>
            </div>
          ))}
        </React.Fragment>
      ))}
      {hasNextPage && (
        <button className="text-sm text-muted" onClick={() => fetchNextPage()} disabled={isFetchingNextPage} style={{ background: 'transparent', border: '1px solid var(--border)' }}>
          {isFetchingNextPage ? 'Loading...' : 'More Comments'}
        </button>
      )}
      {allowedActions.includes('comment') && (
        <form onSubmit={(e) => { e.preventDefault(); commentMutation.mutate({}); }} className="flex-col gap-2 mt-2">
          <textarea 
            rows={2} 
            placeholder="Add a comment..." 
            value={newComment} 
            onChange={e => setNewComment(e.target.value)} 
            disabled={commentMutation.isPending} 
            required 
          />
          <div style={{ textAlign: 'right' }}>
            <button type="submit" disabled={commentMutation.isPending} style={{ padding: '8px 16px', fontSize: '0.875rem' }}>
              {commentMutation.isPending ? 'Posting...' : 'Post Comment'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [selectedTeam, setSelectedTeam] = useState(localStorage.getItem('team_id') || '');
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

  useEffect(() => {
    if (user && selectedTeam && !user.user.memberships[selectedTeam]) {
      setSelectedTeam('');
      localStorage.removeItem('team_id');
    }
  }, [user, selectedTeam]);

  if (!token) return <Login setToken={setToken} />;
  if (isLoading) return <div className="layout"><div className="content"><LoadingSpinner /></div></div>;
  if (!user) {
    localStorage.removeItem('token');
    localStorage.removeItem('team_id');
    setToken('');
    return null;
  }

  const handleTeamChange = (t: string) => {
    setSelectedTeam(t);
    if (t) localStorage.setItem('team_id', t);
    else localStorage.removeItem('team_id');
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('team_id');
    setToken('');
    queryClient.clear();
  };

  return (
    <div className="layout">
      <div className="sidebar">
        <div className="mb-6">
          <h2 className="text-xl" style={{ color: 'var(--primary-hover)', fontWeight: 700, letterSpacing: '-0.05em' }}>Newtonite</h2>
          <div className="text-sm text-muted mt-1">{user.user.name}</div>
        </div>
        
        <div className="mb-6">
          <label className="text-xs text-muted uppercase tracking-wider mb-2 block">Team</label>
          <select value={selectedTeam} onChange={e => handleTeamChange(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', color: 'var(--text)' }}>
            <option value="">All My Teams</option>
            {Object.keys(user.user.memberships).map(id => (
              <option key={id} value={id}>{id.substring(0,8)}</option>
            ))}
          </select>
        </div>

        <Link to="/" className={location.pathname === '/' ? 'active' : ''}><LayoutDashboard size={18} /> Dashboard</Link>
        <Link to="/items" className={location.pathname.startsWith('/items') ? 'active' : ''}><List size={18} /> Work Items</Link>
        <div style={{ flex: 1 }} />
        <button className="flex items-center gap-2" style={{ background: 'transparent', color: 'var(--danger-hover)', justifyContent: 'flex-start', border: 'none' }} onClick={handleLogout}>
          <LogOut size={18} /> Sign Out
        </button>
      </div>
      <div className="content">
        <Routes>
          <Route path="/" element={<Dashboard teamId={selectedTeam} userId={user.user.id} />} />
          <Route path="/items" element={<WorkItemsList teamId={selectedTeam} userId={user.user.id} userMemberships={user.user.memberships} />} />
          <Route path="/items/:id" element={<WorkItemDetail />} />
        </Routes>
      </div>
    </div>
  );
}
