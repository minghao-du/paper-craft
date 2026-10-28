import React, { useEffect, useState } from 'react';
import { read } from './main.jsx';
export function GitHubEvidence({ taskId }) {
  const [evidence, setEvidence] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const load = () => read('/api/github').then(values => setEvidence(values.find(v => v.taskId === taskId))).catch(e => setError(e.message));
    load(); const timer = setInterval(load, 5000); return () => clearInterval(timer);
  }, [taskId]);
  return <details><summary>GitHub delivery</summary>{error && <p role="alert">{error}</p>}{!evidence ? <p>No verified Issue/PR association observed.</p> : <><p>Observed {evidence.observedAt} · last success {evidence.lastSuccessAt || 'Never'} {evidence.stale && '(stale)'}</p>{evidence.error && <p role="alert">{evidence.error}</p>}<p>Source: {evidence.source} · Approval request: unknown</p>{['issue', 'pr'].map(kind => { const value = evidence.value?.[kind]; return value && <div key={kind}><a href={value.url} target="_blank" rel="noreferrer">{kind} #{value.number}: {value.title}</a><p>{value.state} {value.reviewDecision}</p>{kind === 'pr' && <pre>{JSON.stringify({checks: value.statusCheckRollup, reviews: value.reviews}, null, 2)}</pre>}</div>; })}</>}</details>;
}
