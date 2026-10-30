import React, { useEffect, useState } from 'react';
import { read } from './main.jsx';
import { useI18n } from './i18n.jsx';
export function GitHubEvidence({ taskId }) {
  const { t, formatDate, errorText } = useI18n();
  const [evidence, setEvidence] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const load = () =>
      read('/api/github')
        .then((values) => setEvidence(values.find((v) => v.taskId === taskId)))
        .catch((e) => setError(e));
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [taskId]);
  const states = {
    OPEN: t('evidence.open'),
    CLOSED: t('evidence.closed'),
    MERGED: t('evidence.merged'),
  };
  const reviews = {
    APPROVED: t('evidence.approved'),
    CHANGES_REQUESTED: t('evidence.changesRequested'),
    REVIEW_REQUIRED: t('evidence.reviewRequired'),
  };
  return (
    <details>
      <summary>{t('evidence.githubTitle')}</summary>
      {error && <p role="alert">{errorText(error)}</p>}
      {!evidence ? (
        <p>{t('evidence.githubEmpty')}</p>
      ) : (
        <>
          <p>
            {t('evidence.githubMetadata', {
              observed: formatDate(evidence.observedAt),
              success: evidence.lastSuccessAt
                ? formatDate(evidence.lastSuccessAt)
                : t('evidence.never'),
            })}{' '}
            {evidence.stale && t('evidence.stale')}
          </p>
          {evidence.error && <p role="alert">{evidence.error}</p>}
          <p>{t('evidence.githubSource', { source: evidence.source })}</p>
          {['issue', 'pr'].map((kind) => {
            const value = evidence.value?.[kind];
            return (
              value && (
                <div key={kind}>
                  <a href={value.url} target="_blank" rel="noreferrer">
                    {kind === 'issue' ? 'Issue' : 'PR'} #{value.number}: {value.title}
                  </a>
                  <p>
                    {Object.hasOwn(states, value.state) ? states[value.state] : value.state}{' '}
                    {Object.hasOwn(reviews, value.reviewDecision)
                      ? reviews[value.reviewDecision]
                      : value.reviewDecision}
                  </p>
                  {kind === 'pr' && (
                    <pre>
                      {JSON.stringify(
                        { checks: value.statusCheckRollup, reviews: value.reviews },
                        null,
                        2,
                      )}
                    </pre>
                  )}
                </div>
              )
            );
          })}
        </>
      )}
    </details>
  );
}
