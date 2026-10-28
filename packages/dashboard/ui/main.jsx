import { TaskLogs } from './TaskLogs.jsx';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import GitEvidence from './GitEvidence.jsx';
const access = new URLSearchParams(location.hash.slice(1)).get('token');
if (access) {
  sessionStorage.setItem('dashboard-token', access);
  history.replaceState(null, '', location.pathname);
}
export async function read(path) {
  const result = await fetch(path, {
    headers: { Authorization: `Bearer ${sessionStorage.getItem('dashboard-token') || ''}` },
  });
  if (!result.ok)
    throw new Error(`Read failed (${result.status}). Open the startup link to authenticate.`);
  return result.json();
}
function App() {
  const [snapshot, setSnapshot] = useState(null),
    [error, setError] = useState(''),
    [fleetId, setFleetId] = useState(''),
    [query, setQuery] = useState(''),
    [phase, setPhase] = useState(''),
    [attention, setAttention] = useState(false);
  const load = () =>
    read('/api/snapshot')
      .then(setSnapshot)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <main>
      <header>
        <div>
          <h1>Fleet Dashboard</h1>
          <p>Read-only observations · occupancy and execution attempts remain unknown</p>
        </div>
        <button
          onClick={() =>
            read('/api/refresh')
              .then(setSnapshot)
              .catch((e) => setError(e.message))
          }
        >
          Refresh
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {snapshot && (
        <>
          <nav>
            <label>
              Fleet{' '}
              <select value={fleetId} onChange={(e) => setFleetId(e.target.value)}>
                <option value="">All Fleets</option>
                {snapshot.fleets.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.config}
                  </option>
                ))}
              </select>
            </label>{' '}
            <label>
              Search <input value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>{' '}
            <label>
              Phase <input value={phase} onChange={(e) => setPhase(e.target.value)} />
            </label>{' '}
            <label>
              <input
                type="checkbox"
                checked={attention}
                onChange={(e) => setAttention(e.target.checked)}
              />
              Needs attention
            </label>
          </nav>
          <p>
            Observed {snapshot.generatedAt} · version {snapshot.version}
          </p>
          {snapshot.fleets
            .filter((f) => !fleetId || f.id === fleetId)
            .map((fleet) => (
              <section key={fleet.id}>
                <h2>{fleet.config}</h2>
                <p>
                  Fleet {fleet.id} · Project: {fleet.project || 'Unassociated'}
                </p>
                {fleet.error && (
                  <p role="alert">
                    {fleet.error} {fleet.stale && '(stale)'}
                  </p>
                )}
                <GitEvidence fleetId={fleet.id} />
                <table>
                  <thead>
                    <tr>
                      <th>Association</th>
                      <th>Phase</th>
                      <th>Summary / evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fleet.tasks
                      .filter(
                        (t) =>
                          (!phase || t.phase.includes(phase)) &&
                          (!attention || t.interventions?.length) &&
                          [
                            fleet.config,
                            fleet.project,
                            t.slot,
                            t.summary,
                            t.phase,
                            t.issue,
                            ...t.blockers,
                          ]
                            .join(' ')
                            .toLowerCase()
                            .includes(query.toLowerCase()),
                      )
                      .map((task) => (
                        <tr key={task.id}>
                          <td>
                            {task.slot}
                            <small>{task.role}</small>
                          </td>
                          <td>{task.phase}</td>
                          <td>
                            {task.summary}
                            <details>
                              <summary>Evidence {task.stale ? '(stale)' : ''}</summary>
                              <p>Source: {task.source}</p>
                              <p>Observed: {task.observedAt}</p>
                              <p>
                                Runtime: {task.runtime} · execution attempt:{' '}
                                {task.executionIdentity}
                              </p>
                              {task.error && <p role="alert">{task.error}</p>}
                              <p>
                                Waiting: {task.waiting || 'Not recorded'} · last file activity:{' '}
                                {task.modifiedAt || 'Unknown'}
                              </p>
                              <ul>
                                {task.interventions?.map((item, i) => (
                                  <li key={i}>
                                    {item.reason}
                                    <small>Source: {item.source}</small>
                                  </li>
                                ))}
                              </ul>
                              <details>
                                <summary>Runtime observations</summary>
                                <pre>{JSON.stringify(task.runtimeEvidence, null, 2)}</pre>
                              </details>
                              <TaskLogs task={task} read={read} />
                              <p>Blockers: {task.blockers.join(', ') || 'None recorded'}</p>
                            </details>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </section>
            ))}
        </>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')).render(<App />);
