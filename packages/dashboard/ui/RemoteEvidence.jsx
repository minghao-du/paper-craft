import React,{useEffect,useState} from 'react';
import {read} from './main.jsx';
export default function RemoteEvidence({fleetId}){
 const [values,setValues]=useState([]),[error,setError]=useState('');
 useEffect(()=>{let alive=true;const load=()=>read('/api/remote').then(rows=>{if(alive){setValues(rows.filter(r=>r.fleetId===fleetId));setError('');}}).catch(e=>{if(alive)setError(e.message);});load();const timer=setInterval(load,5000);return()=>{alive=false;clearInterval(timer);};},[fleetId]);
 return <details><summary>Associated remote compute tasks</summary>{error&&<p role="alert">{error}</p>}{!values.length&&<p>No explicitly associated remote tasks.</p>}{values.map((v,i)=><section key={i}><strong>{v.slot} · {v.host} · job {v.jobId}</strong><p>{v.state||'unknown'} {v.stale&&'· stale'}</p><p>Source: {v.source} · observed {v.observedAt} · last success {v.lastSuccessAt||'unknown'}</p>{v.error&&<p role="alert">{v.error}</p>}</section>)}<p>Remote evidence does not establish local slot availability. Execution attempts remain unknown.</p></details>;
}
