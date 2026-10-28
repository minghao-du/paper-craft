import React, { useState } from 'react';
export function TaskLogs({ task, read }) {
  const [kind, setKind] = useState('worklog'),
    [log, setLog] = useState(null),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const load = async (source = kind, offset = 0) => {
    try {
      setError('');
      setCopied(false);
      setLog(
        await read(
          `/api/tasks/${encodeURIComponent(task.id)}/logs?source=${source}&offset=${offset}`,
        ),
      );
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !log) load();
      }}
    >
      <summary>Logs</summary>
      <label>
        Source{' '}
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            load(e.target.value);
          }}
        >
          <option value="worklog">Worklog</option>
          <option value="terminal">Verified terminal</option>
          <option value="runner">Runner log</option>
        </select>
      </label>
      <button onClick={() => load()}>Refresh log</button>
      <button
        disabled={!log?.text}
        onClick={() =>
          navigator.clipboard
            .writeText(log.text)
            .then(() => setCopied(true))
            .catch(() => setError('Copy unavailable; select and copy text manually'))
        }
      >
        {copied ? 'Copied' : 'Copy segment'}
      </button>
      {error && <p role="alert">{error}</p>}
      {log && (
        <>
          <small>
            {log.source || kind} · read {log.readAt} · {log.state} · offset {log.offset}
          </small>
          {log.error && <p role="alert">{log.error}</p>}
          {log.detail && <p>{log.detail}</p>}
          <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '24rem', overflow: 'auto' }}>
            {log.text}
          </pre>
          {log.nextOffset != null && (
            <button onClick={() => load(kind, log.nextOffset)}>Next segment</button>
          )}
        </>
      )}
    </details>
  );
}
