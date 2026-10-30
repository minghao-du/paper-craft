import React, { useEffect, useState } from 'react';
import { read } from './main.jsx';
import { useI18n } from './i18n.jsx';
export default function GitEvidence({ fleetId }) {
  const { t, formatDate, errorText } = useI18n();
  const [value, setValue] = useState(null),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () =>
      read('/api/git')
        .then((values) => {
          if (alive) setValue(values.find((v) => v.fleetId === fleetId));
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
  const relations = {
    current: t('evidence.current'),
    behind: t('evidence.behind'),
    ahead: t('evidence.ahead'),
    diverged: t('evidence.diverged'),
  };
  return (
    <details>
      <summary>{t('evidence.gitTitle')}</summary>
      {error && <p role="alert">{errorText(error)}</p>}
      {value ? (
        <>
          <p>
            {t('evidence.metadata', {
              source: value.source,
              observed: formatDate(value.observedAt),
              success: value.lastSuccessAt
                ? formatDate(value.lastSuccessAt)
                : t('evidence.unknown'),
            })}{' '}
            {value.stale && t('evidence.stale')}
          </p>
          {value.error && <p role="alert">{value.error}</p>}
          <p>{t('evidence.gitWarning')}</p>
          {value.value?.slots.map((slot) => (
            <section key={slot.name}>
              <strong>
                {slot.name}: {slot.branch}
              </strong>
              <p>
                {t('evidence.slot', {
                  relation: Object.hasOwn(relations, slot.relation)
                    ? relations[slot.relation]
                    : slot.relation,
                  ahead: slot.ahead,
                  behind: slot.behind,
                  changes: slot.dirty ? t('evidence.dirty') : t('evidence.clean'),
                  hold: slot.held ? t('evidence.held') : t('evidence.noHold'),
                })}
              </p>
              <p>{t('evidence.files', { files: slot.touched.join(', ') || t('evidence.none') })}</p>
              <p>
                {t('evidence.overlap', {
                  files: slot.landedOverlap.join(', ') || t('evidence.none'),
                })}
              </p>
            </section>
          ))}
          {value.value?.unknown.map((finding, i) => (
            <p role="alert" key={i}>
              {finding.slot}: {finding.detail}
            </p>
          ))}
          {value.value?.issues.map((finding, i) => (
            <p key={i}>
              {finding.slot}: {finding.detail}
            </p>
          ))}
        </>
      ) : (
        <p>{t('evidence.gitPending')}</p>
      )}
    </details>
  );
}
