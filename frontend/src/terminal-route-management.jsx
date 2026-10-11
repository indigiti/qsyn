import React from 'react';
import {ArrowUpRight,LockKeyhole,Route,ShieldCheck} from 'lucide-react';
import {terminalRoutes,terminalAliases} from './terminal-routes.js';
import './terminal-unified.css';

/** Operator-visible route directory. Changes are code-reviewed and deployed,
 * rather than allowing arbitrary browser users to mutate server routes.
 * Authentication is still enforced separately by each protected API.
 */
export function RouteManagementWorkspace({openView}){
  return <div className="terminal-page qt-unified">
    <header className="terminal-title"><div>
      <p className="terminal-eyebrow">NAVIGATION · CONTROLLED REGISTRY</p>
      <h1>Route management</h1>
      <p>Canonical workspace addresses and compatibility redirects are governed by the shared QSYN route manifest.</p>
    </div></header>
    <div className="qt-summary">
      <section className="terminal-surface"><Route size={19}/><span>Canonical workspaces</span><strong>{terminalRoutes.length}</strong></section>
      <section className="terminal-surface"><ArrowUpRight size={19}/><span>Retired-page redirects</span><strong>{terminalAliases.length}</strong></section>
      <section className="terminal-surface"><ShieldCheck size={19}/><span>Route changes</span><strong>Code-reviewed</strong></section>
    </div>
    <section className="terminal-surface">
      <div className="terminal-card-head"><h2>Registered React routes</h2><span className="terminal-chip">READ ONLY</span></div>
      <div className="qt-table-wrap"><table className="qt-table">
        <thead><tr><th>Workspace</th><th>Canonical URL</th><th>Access classification</th><th>Navigation</th></tr></thead>
        <tbody>{terminalRoutes.map(r=><tr key={r.view}>
          <td><strong>{r.label}</strong></td>
          <td><code>{r.href}</code></td>
          <td>{r.access.includes('gated')?<LockKeyhole size={13} style={{verticalAlign:'middle'}}/>:null} {r.access}</td>
          <td><button type="button" className="terminal-action terminal-secondary-action"
            onClick={()=>openView(r.view)}>Open <ArrowUpRight size={14}/></button></td>
        </tr>)}</tbody>
      </table></div>
      <p className="terminal-footnote">Route labels do not grant privileges. Upstox feeds, private workspaces and Rust service actions still require account-scoped server authorization.</p>
    </section>
    <section className="terminal-surface"><h2>Legacy URL migration</h2>
      <div className="qt-table-wrap"><table className="qt-table">
        <thead><tr><th>Old URL</th><th>Redirect destination</th><th>Policy</th></tr></thead>
        <tbody>{terminalAliases.map(a=><tr key={a.path}>
          <td><code>{a.path}</code></td><td><code>{a.href}</code></td>
          <td>HTTP 302 · no-store</td></tr>)}</tbody>
      </table></div>
      <p className="terminal-footnote">Add or change routes through the single source manifest, validated PHP resolver and CI tests. Runtime route editing is intentionally disabled.</p>
    </section>
  </div>;
}
