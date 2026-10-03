import React, { useEffect, useState } from 'react';
import { Routes, Route, useNavigate, useLocation, Link } from 'react-router-dom';
import { LayoutDashboard, List, Bell, LogOut, CheckCircle, AlertCircle } from 'lucide-react';

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

function Login({ setToken }: { setToken: (t: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const { token } = await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      localStorage.setItem('token', token);
      setToken(token);
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={handleLogin} className="card flex-col gap-4" style={{ width: 400 }}>
        <h2 className="text-xl mb-4">Login to Newtonite</h2>
        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
        <input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
        <input placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} />
        <button type="submit">Login</button>
      </form>
    </div>
  );
}

function Dashboard({ teamId }: { teamId: string }) {
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    api(`/api/v1/dashboard?team_id=${teamId}`).then(setStats).catch(console.error);
  }, [teamId]);

  if (!stats) return <div>Loading...</div>;

  return (
    <div>
      <h1 className="text-xl mb-4">Dashboard</h1>
      <div className="flex gap-4">
        <div className="card">
          <div className="text-muted">Assigned to me</div>
          <div className="text-xl">{stats.assignedToMe}</div>
        </div>
        <div className="card">
          <div className="text-muted">Awaiting Approval</div>
          <div className="text-xl">{stats.awaitingApproval}</div>
        </div>
        <div className="card">
          <div className="text-muted">Unassigned Urgent</div>
          <div className="text-xl" style={{ color: 'var(--danger)' }}>{stats.unassignedUrgent}</div>
        </div>
      </div>
    </div>
  );
}

function WorkItemsList({ teamId }: { teamId: string }) {
  const [items, setItems] = useState<any[]>([]);

  useEffect(() => {
    api(`/api/v1/work-items?team_id=${teamId}`).then(data => setItems(data.items)).catch(console.error);
  }, [teamId]);

  return (
    <div>
      <h1 className="text-xl mb-4">Work Items</h1>
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Priority</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id}>
                <td><Link to={`/items/${item.id}`}>{item.title}</Link></td>
                <td><span className={`badge ${item.status}`}>{item.status}</span></td>
                <td>{item.priority}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WorkItemDetail() {
  const [item, setItem] = useState<any>(null);
  const id = useLocation().pathname.split('/').pop();

  useEffect(() => {
    api(`/api/v1/work-items/${id}`).then(setItem).catch(console.error);
  }, [id]);

  const action = async (url: string, body?: any) => {
    try {
      const headers: any = {};
      if (body) {
        // Simple idempotency key based on random UUID per request attempt
        headers['Idempotency-Key'] = crypto.randomUUID();
      }
      const newItem = await api(url, {
        method: 'POST',
        headers,
        body: body ? JSON.stringify(body) : undefined
      });
      setItem(newItem);
    } catch (err: any) {
      if (err.cause?.status === 409) {
        alert('Conflict detected, refreshing...');
        api(`/api/v1/work-items/${id}`).then(setItem);
      } else {
        alert(err.message);
      }
    }
  };

  if (!item) return <div>Loading...</div>;

  return (
    <div className="flex-col gap-4">
      <div className="card">
        <h1 className="text-xl">{item.title}</h1>
        <div className="flex gap-2 mt-4">
          <span className={`badge ${item.status}`}>{item.status}</span>
          <span className="badge">{item.priority}</span>
        </div>
        <p className="mt-4">{item.description}</p>
        
        <div className="flex gap-2 mt-4">
          {item.allowedActions.includes('claim') && <button onClick={() => action(`/api/v1/work-items/${id}/claim`, {})}>Claim</button>}
          {item.allowedActions.includes('unassign') && <button onClick={() => action(`/api/v1/work-items/${id}/release`, {})}>Release</button>}
          {item.allowedActions.includes('transition') && <button onClick={() => action(`/api/v1/work-items/${id}/transition`, { version: item.version, status: 'in_progress' })}>Start Work</button>}
          {item.allowedActions.includes('transition') && <button onClick={() => action(`/api/v1/work-items/${id}/transition`, { version: item.version, status: 'resolved' })}>Resolve</button>}
          {item.allowedActions.includes('approve_reject') && <button onClick={() => action(`/api/v1/work-items/${id}/approve`, { version: item.version })}>Approve</button>}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState<any>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (token) {
      api('/api/v1/auth/me')
        .then(data => setUser(data.user))
        .catch(() => {
          localStorage.removeItem('token');
          setToken('');
        });
    }
  }, [token]);

  if (!token) return <Login setToken={setToken} />;
  if (!user) return <div>Loading...</div>;

  const teamId = Object.keys(user.memberships)[0];

  return (
    <div className="layout">
      <div className="sidebar">
        <h2 className="text-xl mb-4" style={{ color: 'var(--primary)' }}>Newtonite</h2>
        <Link to="/" className="flex items-center gap-2"><LayoutDashboard size={18} /> Dashboard</Link>
        <Link to="/items" className="flex items-center gap-2"><List size={18} /> Work Items</Link>
        <div style={{ flex: 1 }} />
        <button className="flex items-center gap-2" style={{ background: 'transparent', color: 'var(--danger)', justifyContent: 'flex-start' }} onClick={() => { localStorage.removeItem('token'); setToken(''); }}>
          <LogOut size={18} /> Logout
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
