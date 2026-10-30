import React, { useEffect, useState } from 'react';
import { read } from './main.jsx';
import { useI18n } from './i18n.jsx';
export default function RemoteEvidence({ fleetId }) {
  const { t, formatDate, errorText } = useI18n();
  const [values, setValues] = useState([]),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () =>
      read('/api/remote')
        .then((rows) => {
          if (alive) {
            setValues(rows.filter((r) => r.fleetId === fleetId));
            setError('');
          }
        })
        .catch((e) => {
          if (alive) setError(e);
        });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [fleetId]);
  return (
    <details>
      <summary>{t('evidence.remoteTitle')}</summary>
      {error && <p role="alert">{errorText(error)}</p>}
      {!values.length && <p>{t('evidence.remoteEmpty')}</p>}
      {values.map((v, i) => (
        <section key={i}>
          <strong>{t('evidence.remoteJob', { slot: v.slot, host: v.host, job: v.jobId })}</strong>
          <p>
            {v.state || t('evidence.unknown')} {v.stale && t('evidence.stale')}
          </p>
          <p>
            {t('evidence.metadata', {
              source: v.source,
              observed: formatDate(v.observedAt),
              success: v.lastSuccessAt ? formatDate(v.lastSuccessAt) : t('evidence.unknown'),
            })}
          </p>
          {v.error && <p role="alert">{v.error}</p>}
        </section>
      ))}
      <p>{t('evidence.remoteWarning')}</p>
    </details>
  );
}
