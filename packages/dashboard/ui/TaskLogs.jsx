import React, { useState } from 'react';
import { useI18n } from './i18n.jsx';
/** Read original log segments with localized controls and metadata. */
export function TaskLogs({ task, read }) {
  const { t, formatDate, errorText } = useI18n();
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
      setError(e);
    }
  };
  const states = {
    read: t('logs.stateRead'),
    absent: t('logs.stateAbsent'),
    error: t('logs.stateError'),
    unknown: t('logs.stateUnknown'),
  };
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !log) load();
      }}
    >
      <summary>{t('logs.heading')}</summary>
      <label>
        {t('logs.source')}{' '}
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            load(e.target.value);
          }}
        >
          <option value="worklog">{t('logs.worklog')}</option>
          <option value="terminal">{t('logs.terminal')}</option>
          <option value="runner">{t('logs.runner')}</option>
        </select>
      </label>
      <button onClick={() => load()}>{t('logs.refresh')}</button>
      <button
        disabled={!log?.text}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(log.text);
            setError('');
            setCopied(true);
          } catch {
            setCopied(false);
            setError({ translationKey: 'logs.copyFailed' });
          }
        }}
      >
        {copied ? t('logs.copied') : t('logs.copy')}
      </button>
      {error && <p role="alert">{errorText(error)}</p>}
      {log && (
        <>
          <small>
            {t('logs.metadata', {
              source: log.source || kind,
              readAt: formatDate(log.readAt),
              state: Object.hasOwn(states, log.state) ? states[log.state] : log.state,
              offset: log.offset,
            })}
          </small>
          {log.error && <p role="alert">{log.error}</p>}
          {log.detail && <p>{log.detail}</p>}
          <pre
            aria-label={t('logs.segment')}
            style={{ whiteSpace: 'pre-wrap', maxHeight: '24rem', overflow: 'auto' }}
          >
            {log.text}
          </pre>
          {log.nextOffset != null && (
            <button onClick={() => load(kind, log.nextOffset)}>{t('logs.next')}</button>
          )}
        </>
      )}
    </details>
  );
}
