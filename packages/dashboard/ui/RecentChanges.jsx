import React, {useEffect,useState} from 'react';
export default function RecentChanges({read,fleetId}) {
 const [value,setValue]=useState(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;const load=()=>read('/api/history').then(v=>{if(active)setValue(v)}).catch(()=>{if(active)setError('Observation history unavailable')});load();const timer=setInterval(load,5000);return()=>{active=false;clearInterval(timer)}},[]);
 return <section><h2>Recent observed changes</h2><p>30-day retention · observations only · execution attempts unknown</p>{error&&<p role="alert">{error}</p>}{value&&<><p>{value.coverage}</p><ul>{value.events.filter(e=>!fleetId||!e.fleetId||e.fleetId===fleetId).slice(0,100).map((e,i)=><li key={i}>{e.observedAt} · {e.kind==='monitoring-gap'?`Monitoring gap since ${e.gapFrom}; unseen changes unknown`:`${e.source} evidence changed · Fleet ${e.fleetId} · ${e.subject}`}</li>)}</ul></>}</section>
}
