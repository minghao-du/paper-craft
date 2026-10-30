import React, { useEffect, useState } from 'react';
import { useI18n } from './i18n.jsx';

export default function RecentChanges({ read, fleetId }) {
  const { t, formatDate, errorText } = useI18n();
  const [value, setValue] = useState(null),
    [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    const load = () =>
      read('/api/history')
        .then((v) => {
          if (active) setValue(v);
        })
        .catch((e) => {
          if (active) setError(e);
        });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <section className="recent-changes">
      <h2>{t('history.heading')}</h2>
      <p>{t('history.retention')}</p>
      {error && <p role="alert">{t('history.unavailable', { detail: errorText(error) })}</p>}
      {value && (
        <>
          <p>{t('history.coverage')}</p>
          <ul>
            {value.events
              .filter((e) => !fleetId || !e.fleetId || e.fleetId === fleetId)
              .slice(0, 100)
              .map((e, i) => (
                <li key={i}>
                  {e.kind === 'monitoring-gap'
                    ? t('history.gap', {
                        observedAt: formatDate(e.observedAt),
                        gapFrom: formatDate(e.gapFrom),
                      })
                    : t('history.change', {
                        observedAt: formatDate(e.observedAt),
                        source: e.source,
                        fleetId: e.fleetId,
                        subject: e.subject,
                      })}
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
}
