import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent, type ReactNode } from 'react';
import {
  Activity, ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, CircleHelp,
  Copy, FolderOpen, Headphones, Keyboard, Laptop, Link2, LoaderCircle, LockKeyhole,
  Monitor, MoreHorizontal, Mouse, Move, Network, Pause, Play, Plus, Radio,
  RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Terminal,
  Trash2, Volume2, Wifi, X, Zap,
} from 'lucide-react';
import type { AppState, Device, ScreenPlacement, Settings } from '../shared/types';

interface HeyMouseBridge {
  getState(): Promise<AppState>;
  onState(listener: (state: AppState) => void): () => void;
  updateSettings(patch: Partial<Settings>): Promise<AppState>;
  setLayout(layout: ScreenPlacement[]): Promise<AppState>;
  refreshDiscovery(): Promise<void>;
  createInvite(): Promise<{ code: string; expiresAt: number }>;
  pair(code: string): Promise<AppState>;
  forgetDevice(id: string): Promise<AppState>;
  startSharing(): Promise<AppState>;
  stopSharing(): Promise<AppState>;
  selectEngine(): Promise<AppState>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
}

const bridge = (window as unknown as { heymouse?: HeyMouseBridge }).heymouse;
type Page = 'connections' | 'devices' | 'audio' | 'settings';
const platformNames: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);

function PlatformIcon({ platform, size = 18 }: { platform: string; size?: number }) {
  if (platform === 'win32') return <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-label="Windows"><path d="M1 3.2 8.8 2v7H1zm9-1.4L19 .5V9h-9zM1 10h7.8v7L1 15.8zm9 0h9v8.5l-9-1.3z" /></svg>;
  return platform === 'darwin' ? <Laptop size={size} /> : <Terminal size={size} />;
}

function BrandMark({ size = 30 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect width="36" height="36" rx="11" fill="currentColor" /><path d="M10.5 9v19l5.1-5.5 4.1 8 3.6-1.9-4.1-7.8h7.5L10.5 9Z" fill="#151810" stroke="#151810" strokeWidth="1.6" strokeLinejoin="round" /></svg>;
}

function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return <button className={`toggle ${checked ? 'is-on' : ''}`} type="button" role="switch" aria-checked={checked} aria-label={label} onClick={onChange} disabled={disabled}><span /></button>;
}

function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'green' | 'muted' | 'amber' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function Dialog({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.focus();
    const listener = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && dialog) {
        const elements = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'));
        const first = elements[0]; const last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', listener);
    return () => { document.removeEventListener('keydown', listener); previous?.focus(); };
  }, [onClose]);
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabIndex={-1} ref={dialogRef}><div className="dialog-header"><div><h2 id="dialog-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="Fechar janela" onClick={onClose}><X size={19} /></button></div>{children}</div></div>;
}

function Workspace({ state, onPair, onLayout, onDevice }: { state: AppState; onPair: () => void; onLayout: (layout: ScreenPlacement[]) => Promise<unknown>; onDevice: (device: Device) => void }) {
  const devices = [state.local, ...state.devices.filter(device => device.paired)];
  const canvasRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; startX: number; startY: number; dx: number; dy: number } | null>(null);
  const [width, setWidth] = useState(850);
  const [hint, setHint] = useState('');
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, []);
  const placements = devices.map((device, index) => state.layout.find(item => item.deviceId === device.id) ?? { deviceId: device.id, x: index, y: 0 });
  const minX = Math.min(...placements.map(item => item.x)); const maxX = Math.max(...placements.map(item => item.x)) + (devices.length === 1 ? 1 : 0);
  const minY = Math.min(...placements.map(item => item.y)); const maxY = Math.max(...placements.map(item => item.y));
  const scale = Math.min(1, (width - 64) / ((maxX - minX + 1) * 224), 330 / ((maxY - minY + 1) * 166));
  const centerX = (minX + maxX) / 2; const centerY = (minY + maxY) / 2;
  const pointStyle = (x: number, y: number, id?: string): CSSProperties => ({
    left: `calc(50% + ${(x - centerX) * 224 * scale}px)`,
    top: `calc(47% + ${(y - centerY) * 166 * scale}px)`,
    transform: `translate(-50%, -50%) translate(${drag && drag.id === id ? drag.dx : 0}px, ${drag && drag.id === id ? drag.dy : 0}px) scale(${scale})`,
  });
  const beginDrag = (event: PointerEvent<HTMLDivElement>, id: string) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setHint(''); setDrag({ id, startX: event.clientX, startY: event.clientY, dx: 0, dy: 0 });
  };
  const finishDrag = async () => {
    if (!drag) return;
    const original = placements.find(item => item.deviceId === drag.id)!;
    const x = Math.max(-5, Math.min(5, original.x + Math.round(drag.dx / (224 * scale))));
    const y = Math.max(-5, Math.min(5, original.y + Math.round(drag.dy / (166 * scale))));
    setDrag(null);
    if (placements.some(item => item.deviceId !== drag.id && item.x === x && item.y === y)) { setHint('Essa posição já está ocupada. Escolha uma posição ao lado.'); return; }
    if (x === original.x && y === original.y) return;
    await onLayout(placements.map(item => item.deviceId === drag.id ? { ...item, x, y } : item));
  };
  const moveWithKeyboard = async (event: React.KeyboardEvent<HTMLDivElement>, deviceId: string) => {
    if (!(event.key in { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1 })) return;
    event.preventDefault();
    const current = placements.find(item => item.deviceId === deviceId)!;
    const x = current.x + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0);
    const y = current.y + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0);
    if (Math.abs(x) > 5 || Math.abs(y) > 5 || placements.some(item => item.deviceId !== deviceId && item.x === x && item.y === y)) return;
    await onLayout(placements.map(item => item.deviceId === deviceId ? { ...item, x, y } : item));
  };
  return <section className="workspace panel">
    <div className="panel-heading"><div><h2>Seu espaço de trabalho <span className="count-badge">{devices.length}</span></h2><p>Organize as telas como elas estão na sua mesa.</p></div><span className="subtle-label"><Move size={14} /> Arraste para organizar</span></div>
    <div className={`screen-canvas ${drag ? 'is-dragging' : ''}`} ref={canvasRef}>
      <div className="canvas-corner"><span className="tiny-dot" /> REDE LOCAL</div>
      {devices.map(device => {
        const placement = placements.find(item => item.deviceId === device.id)!;
        const local = device.id === state.local.id;
        return <div key={device.id} className={`screen-group ${local ? 'is-local' : ''} ${!device.online ? 'is-offline' : ''} ${drag?.id === device.id ? 'is-moving' : ''}`} style={pointStyle(placement.x, placement.y, device.id)} onPointerDown={event => beginDrag(event, device.id)} onPointerMove={event => { if (drag?.id === device.id) setDrag({ ...drag, dx: event.clientX - drag.startX, dy: event.clientY - drag.startY }); }} onPointerUp={() => void finishDrag()} onPointerCancel={() => setDrag(null)} onKeyDown={event => void moveWithKeyboard(event, device.id)} tabIndex={0} role="group" aria-label={`${device.name}. Use as setas para mover a tela.`}>
          <div className="monitor-shell"><div className="monitor-surface"><div className="monitor-top"><PlatformIcon platform={device.platform} size={19} /><button aria-label={`Detalhes de ${device.name}`} onClick={() => onDevice(device)}><MoreHorizontal size={17} /></button></div><strong>{device.name}</strong><span className="monitor-os">{platformNames[device.platform]} {local ? '· Este computador' : ''}</span><div className="monitor-status"><span className={`status-dot ${device.online ? 'online' : ''}`} />{local ? (state.settings.engine.role === 'server' ? 'Mouse e teclado daqui' : 'Recebe mouse e teclado') : device.online ? 'Na sua rede' : 'Fora da rede'}</div></div></div><div className="monitor-neck" /><div className="monitor-base" /><div className="screen-caption">{local ? <><Mouse size={12} /><Keyboard size={13} /><span>ESTE COMPUTADOR</span></> : <><span>{device.addresses[0] ?? 'Aguardando endereço'}</span>{state.latency[device.id] !== undefined && device.online && <span className="latency-label">{state.latency[device.id].toFixed(0)} ms</span>}</>}</div>
        </div>;
      })}
      {devices.length === 1 && <button className="add-screen" style={pointStyle(placements[0].x + 1, placements[0].y)} onClick={onPair}><span className="add-screen-icon"><Plus size={22} /></span><strong>Mais uma tela?</strong><span>Conecte outro computador</span></button>}
      <div className="canvas-bottom"><span>{hint || 'Passe o cursor pela borda de uma tela para continuar na próxima.'}</span><span className="canvas-scale">{Math.round(scale * 100)}%</span></div>
    </div>
    <div className="workspace-bottom"><div><ShieldCheck size={15} /><span>Os aparelhos são reconhecidos pela identidade, mesmo com um novo IP.</span></div><span className="local-only"><span className="status-dot online" /> Sem nuvem</span></div>
  </section>;
}

function PairDialog({ onClose, onState, onError }: { onClose: () => void; onState: (state: AppState) => void; onError: (message: string) => void }) {
  const [tab, setTab] = useState<'invite' | 'join'>('invite');
  const [invite, setInvite] = useState<{ code: string; expiresAt: number } | null>(null);
  const [code, setCode] = useState(''); const [busy, setBusy] = useState(false); const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const create = async () => { setBusy(true); try { setInvite(await bridge!.createInvite()); setCopied(false); } catch (error) { onError(errorText(error)); } finally { setBusy(false); } };
  const pair = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { onState(await bridge!.pair(code.trim())); onClose(); } catch (error) { onError(errorText(error)); } finally { setBusy(false); } };
  const expired = invite ? now >= invite.expiresAt : false;
  return <Dialog title="Vamos conectar suas telas" subtitle="O primeiro pareamento é feito uma única vez." onClose={onClose}>
    <div className="dialog-tabs"><button className={tab === 'invite' ? 'selected' : ''} onClick={() => setTab('invite')}>Gerar código</button><button className={tab === 'join' ? 'selected' : ''} onClick={() => setTab('join')}>Digitar código</button></div>
    {tab === 'invite' ? <div className="pair-content"><div className="pair-illustration"><div><Monitor size={34} /><small>Este computador</small></div><div className="pair-link"><span /><Link2 size={20} /><span /></div><div><Laptop size={34} /><small>Outro computador</small></div></div><p className="body-copy">Gere um código aqui e digite em <strong>“Digitar código”</strong> no HeyMouse do outro computador. Ambos precisam estar na mesma rede.</p>{invite ? <><label className="field-label" htmlFor="invite-code">Seu código <Badge tone={expired ? 'amber' : 'green'}>{expired ? 'Expirado' : `Válido por ${Math.max(1, Math.ceil((invite.expiresAt - now) / 60000))} min`}</Badge></label><input id="invite-code" className="code-field" readOnly value={invite.code} onFocus={event => event.target.select()} /><button className="button primary full-width" disabled={expired || busy} onClick={async () => { try { await bridge!.copyText(invite.code); setCopied(true); } catch (error) { onError(errorText(error)); } }}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Código copiado' : 'Copiar código'}</button><button className="text-button centered" disabled={busy} onClick={() => void create()}>Gerar novo código</button></> : <button className="button primary full-width" disabled={busy} onClick={() => void create()}>{busy ? <LoaderCircle size={17} className="spin" /> : <Link2 size={17} />} Gerar código de pareamento</button>}<div className="inline-note"><LockKeyhole size={15} /><span>Compartilhe o código apenas com o computador que você deseja parear.</span></div></div> : <form className="pair-content" onSubmit={event => void pair(event)}><div className="join-symbol"><Link2 size={29} /></div><p className="body-copy">No outro computador, abra <strong>Parear dispositivo → Gerar código</strong>. Digite o código que aparecer.</p><label className="field-label" htmlFor="pair-code">Código de pareamento</label><input id="pair-code" className="code-field" placeholder="000000" value={code} onChange={event => setCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))} inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" autoFocus required spellCheck={false} /><button className="button primary full-width" disabled={busy || code.length !== 6}>{busy ? <LoaderCircle size={17} className="spin" /> : <Link2 size={17} />}{busy ? 'Conectando…' : 'Parear computadores'}</button><div className="inline-note"><ShieldCheck size={15} /><span>Depois de pareado, o aparelho será encontrado automaticamente quando estiver na sua rede.</span></div></form>}
  </Dialog>;
}

function DeviceRow({ device, localId, latency, onClick }: { device: Device; localId: string; latency?: number; onClick: () => void }) {
  const local = device.id === localId;
  return <button className="device-row" onClick={onClick}><span className={`device-icon ${local ? 'device-icon-local' : ''}`}><PlatformIcon platform={device.platform} size={21} /></span><span className="device-info"><strong>{device.name}{local && <span className="inline-local">Este computador</span>}</strong><span>{platformNames[device.platform]}<i />{device.addresses[0] ?? 'Sem endereço na rede'}</span></span><span className="device-meta">{latency !== undefined && device.online && <span className="ping"><Activity size={12} />{latency.toFixed(0)} ms</span>}<span className="device-state"><span className={`status-dot ${device.online ? 'online' : ''}`} />{local ? 'Disponível' : device.paired ? device.online ? 'Na rede' : 'Offline' : 'Não pareado'}</span></span><ChevronRight size={16} className="row-chevron" /></button>;
}

function SettingsPage({ state, run, onState }: { state: AppState; run: (action: () => Promise<unknown>) => Promise<void>; onState: (state: AppState) => void }) {
  const [name, setName] = useState(state.settings.deviceName); const [port, setPort] = useState(String(state.settings.engine.port));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setName(state.settings.deviceName); setPort(String(state.settings.engine.port)); }, [state.settings.deviceName, state.settings.engine.port]);
  const update = (patch: Partial<Settings>) => run(async () => { setSaving(true); try { onState(await bridge!.updateSettings(patch)); } finally { setSaving(false); } });
  const updateEngine = (patch: Partial<Settings['engine']>) => update({ engine: { ...state.settings.engine, ...patch } });
  return <div className="settings-grid">
    <section className="panel settings-panel"><div className="settings-heading"><Monitor size={20} /><div><h2>Este computador</h2><p>Como ele aparece nos seus outros aparelhos.</p></div></div><form className="settings-form" onSubmit={event => { event.preventDefault(); void update({ deviceName: name.trim() }); }}><label className="field-label" htmlFor="device-name">Nome do computador</label><div className="input-action"><input id="device-name" value={name} onChange={event => setName(event.target.value)} maxLength={48} required /><button className="button secondary" disabled={saving || !name.trim() || name.trim() === state.settings.deviceName}>Salvar</button></div></form><div className="settings-divider" /><div className="setting-row"><div><h3>Função neste espaço</h3><p>Escolha de onde vêm o mouse e o teclado.</p></div></div><div className="role-choices"><button className={state.settings.engine.role === 'server' ? 'selected' : ''} onClick={() => void updateEngine({ role: 'server' })} disabled={saving}><Mouse size={21} /><span><strong>Compartilhar daqui</strong><small>Usar meu mouse e teclado nas outras telas</small></span>{state.settings.engine.role === 'server' && <Check size={17} />}</button><button className={state.settings.engine.role === 'client' ? 'selected' : ''} onClick={() => void updateEngine({ role: 'client' })} disabled={saving}><Monitor size={21} /><span><strong>Receber de outro</strong><small>Controlar esta tela pelo outro computador</small></span>{state.settings.engine.role === 'client' && <Check size={17} />}</button></div>{state.settings.engine.role === 'client' && <div className="server-selection"><label className="field-label" htmlFor="server-device">Computador que compartilha</label><select id="server-device" value={state.settings.engine.serverDeviceId ?? ''} onChange={event => void updateEngine({ serverDeviceId: event.target.value || null })}><option value="">Selecione um aparelho pareado</option>{state.devices.filter(device => device.paired).map(device => <option key={device.id} value={device.id}>{device.name}{device.online ? '' : ' (offline)'}</option>)}</select>{!state.devices.some(device => device.paired) && <p className="field-hint">Pareie o outro computador primeiro, na aba Dispositivos.</p>}</div>}</section>
    <section className="panel settings-panel"><div className="settings-heading"><SlidersHorizontal size={20} /><div><h2>Do seu jeito</h2><p>Menos cliques no dia a dia.</p></div></div><div className="setting-row"><div><h3>Conectar ao abrir</h3><p>Iniciar o compartilhamento ao abrir o HeyMouse.</p></div><Toggle checked={state.settings.engine.autoStart} onChange={() => void updateEngine({ autoStart: !state.settings.engine.autoStart })} label="Conectar ao abrir" disabled={saving} /></div><div className="setting-row"><div><h3>Abrir minimizado</h3><p>Manter o aplicativo na bandeja ao iniciar.</p></div><Toggle checked={state.settings.startMinimized} onChange={() => void update({ startMinimized: !state.settings.startMinimized })} label="Abrir minimizado" disabled={saving} /></div><div className="setting-row"><div><h3>Continuar em segundo plano</h3><p>Fechar a janela sem encerrar o compartilhamento.</p></div><Toggle checked={state.settings.closeToTray} onChange={() => void update({ closeToTray: !state.settings.closeToTray })} label="Continuar em segundo plano" disabled={saving} /></div><div className="setting-row"><div><h3>Descoberta automática</h3><p>Encontrar aparelhos quando entrarem na rede.</p></div><Toggle checked={state.settings.discoveryEnabled} onChange={() => void update({ discoveryEnabled: !state.settings.discoveryEnabled })} label="Descoberta automática" disabled={saving} /></div></section>
    <section className="panel settings-panel engine-panel"><div className="settings-heading"><Zap size={20} /><div><h2>Motor de compartilhamento</h2><p>Deskflow cuida da captura e do envio de mouse e teclado.</p></div><Badge tone={state.engine.executablePath ? 'green' : 'amber'}>{state.engine.executablePath ? 'Detectado' : 'Não encontrado'}</Badge></div><div className="engine-path"><FolderOpen size={18} /><span>{state.engine.executablePath || state.settings.engine.executablePath || 'Selecione o executável deskflow-core'}</span><button className="button secondary compact" onClick={() => void run(async () => onState(await bridge!.selectEngine()))}>Localizar</button></div><div className="engine-metadata"><span>Versão <strong>{state.engine.version ?? '—'}</strong></span><button className="text-button" onClick={() => void run(() => bridge!.openExternal('https://github.com/deskflow/deskflow/releases'))}>Obter Deskflow <ArrowUpRight size={14} /></button></div><div className="settings-divider" /><form className="advanced-fields" onSubmit={event => { event.preventDefault(); void updateEngine({ port: Number(port) }); }}><div><label className="field-label" htmlFor="input-port">Porta de compartilhamento</label><div className="input-action"><input id="input-port" type="number" min={1024} max={65535} step={1} value={port} onChange={event => setPort(event.target.value)} required /><button className="button secondary" disabled={saving || Number(port) === state.settings.engine.port}>Salvar</button></div><p className="field-hint">TCP · permita esta porta no firewall da rede privada.</p></div><div><label className="field-label" htmlFor="screen-name">Identidade da tela</label><input id="screen-name" value={state.settings.engine.screenName} readOnly /><p className="field-hint">Nome estável usado pelo motor para reconhecer esta tela.</p></div></form><details className="logs-details"><summary><Terminal size={15} /> Diagnóstico do motor <ChevronRight size={14} /></summary><pre>{state.engine.logs.length ? state.engine.logs.join('\n') : 'Nenhum registro ainda. Inicie uma conexão para acompanhar o motor.'}</pre></details></section>
  </div>;
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null); const [page, setPage] = useState<Page>('connections');
  const [loadError, setLoadError] = useState(''); const [busy, setBusy] = useState(false); const [refreshing, setRefreshing] = useState(false);
  const [pairOpen, setPairOpen] = useState(false); const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [confirmForget, setConfirmForget] = useState(false); const [query, setQuery] = useState(''); const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showError = useCallback((message: string) => { setToast(message); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 7000); }, []);
  useEffect(() => { if (!bridge) return; let active = true; bridge.getState().then(value => { if (active) setState(value); }).catch(error => { if (active) setLoadError(errorText(error)); }); const unsubscribe = bridge.onState(value => { if (active) setState(value); }); return () => { active = false; unsubscribe(); }; }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  const run = useCallback(async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { showError(errorText(error)); } }, [showError]);
  const closePair = useCallback(() => setPairOpen(false), []);
  const closeDevice = useCallback(() => { setSelectedDevice(null); setConfirmForget(false); }, []);
  const showDevice = (device: Device) => { setConfirmForget(false); setSelectedDevice(device); };
  const refresh = async () => { setRefreshing(true); await run(() => bridge!.refreshDiscovery()); setTimeout(() => setRefreshing(false), 700); };
  const toggleSharing = async () => { if (!state || !bridge) return; setBusy(true); await run(async () => setState(await (state.engine.status === 'running' || state.engine.status === 'starting' ? bridge.stopSharing() : bridge.startSharing()))); setBusy(false); };
  const running = state?.engine.status === 'running'; const starting = state?.engine.status === 'starting';
  const paired = state?.devices.filter(device => device.paired) ?? [];
  const discovered = state?.devices.filter(device => !device.paired && device.online) ?? [];
  const pageTitles: Record<Page, [string, string]> = {
    connections: ['Seu espaço. Sem limites.', 'Um mouse e um teclado, em todos os seus computadores.'],
    devices: ['Todos no mesmo lugar.', 'Seus computadores, sempre a uma conexão de distância.'],
    audio: ['O próximo som vem aí.', 'Um espaço conectado também merece um áudio conectado.'],
    settings: ['Um setup com a sua cara.', 'Ajuste o HeyMouse ao seu jeito de trabalhar.'],
  };
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><BrandMark /><span>HeyMouse<span className="brand-period">.</span></span></div><span className="sidebar-label">SEU WORKSPACE</span><nav aria-label="Navegação principal"><button className={page === 'connections' ? 'active' : ''} onClick={() => setPage('connections')}><Network size={19} /><span>Conexões</span>{page === 'connections' && <span className="nav-active-dot" />}</button><button className={page === 'devices' ? 'active' : ''} onClick={() => setPage('devices')}><Monitor size={19} /><span>Dispositivos</span>{paired.length > 0 && <span className="nav-count">{paired.length + 1}</span>}</button><button className={page === 'audio' ? 'active' : ''} onClick={() => setPage('audio')}><Headphones size={19} /><span>Áudio</span><span className="soon-tag">EM BREVE</span></button><div className="nav-divider" /><button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><Settings2 size={19} /><span>Configurações</span></button></nav><div className="sidebar-bottom"><div className="network-card"><span className="network-card-icon"><Wifi size={17} /></span><div><strong>{state?.discovery.active ? 'Em casa na sua rede' : 'Sua rede, seu espaço'}</strong><span>{state?.discovery.active ? 'Descoberta automática ativa' : 'Conexão direta entre aparelhos'}</span></div><span className={`status-dot ${state?.discovery.active ? 'online' : ''}`} /></div><div className="sidebar-footer"><span>HEY MOUSE <span>v0.1</span></span><button className="icon-button" aria-label="Ajuda para conectar" onClick={() => { setPage('connections'); showError('Instale o HeyMouse nos dois computadores, conecte ambos à mesma rede e use “Parear dispositivo”. Em Configurações, escolha qual compartilha o mouse e o teclado.'); }}><CircleHelp size={16} /></button></div></div></aside>
    <main className="main-content"><header className="topbar"><div className="breadcrumb">Workspace <ChevronRight size={12} /><span>{page === 'connections' ? 'Conexões' : page === 'devices' ? 'Dispositivos' : page === 'settings' ? 'Configurações' : 'Áudio'}</span></div><div className="topbar-right"><span className="topbar-local"><LockKeyhole size={13} /> Local por natureza</span><span className="topbar-divider" /><span className="avatar">{state?.local.name.substring(0, 2).toUpperCase() ?? 'HM'}</span></div></header>
      {!state ? <div className="desktop-unavailable"><div className="welcome-art"><BrandMark size={54} /><span /><Monitor size={52} /></div><Badge tone="green">SEU NOVO WORKSPACE</Badge><h1>{loadError ? 'Não foi possível iniciar' : bridge ? 'Preparando seu espaço…' : 'Abra o HeyMouse no desktop'}</h1><p>{loadError || (bridge ? 'Estamos identificando este computador e sua rede local.' : 'A descoberta de aparelhos e o compartilhamento de mouse e teclado funcionam no aplicativo para Windows, macOS e Linux.')}</p>{bridge && !loadError && <LoaderCircle size={22} className="spin" />}{loadError && <button className="button primary" onClick={() => window.location.reload()}><RefreshCw size={16} /> Tentar novamente</button>}<div className="welcome-platforms"><PlatformIcon platform="win32" /><span>Windows</span><i /> <PlatformIcon platform="darwin" /><span>macOS</span><i /><PlatformIcon platform="linux" /><span>Linux</span></div></div> : <div className={`page-content page-${page}`}>
        <div className="page-heading"><div><div className="eyebrow">{page === 'connections' ? 'BEM-VINDO AO SEU WORKSPACE' : page === 'devices' ? 'SEU ECOSSISTEMA' : page === 'settings' ? 'PREFERÊNCIAS' : 'EXPERIMENTAL · PLANEJADO'}</div><h1>{pageTitles[page][0]}</h1><p>{pageTitles[page][1]}</p></div>{page !== 'audio' && page !== 'settings' && <button className="button primary" onClick={() => setPairOpen(true)}><Plus size={17} /> Parear dispositivo</button>}</div>
        {state.discovery.error && <div className="notice notice-warning"><Wifi size={17} /><span>{state.discovery.error}</span><button onClick={() => void refresh()} disabled={refreshing}>Tentar novamente</button></div>}
        {state.engine.status === 'error' && <div className="notice notice-warning"><Zap size={17} /><span>{state.engine.message}</span><button onClick={() => setPage('settings')}>Ver configurações</button></div>}
        {page === 'connections' && <>
          <div className="sharing-strip"><div className={`sharing-symbol ${running ? 'is-running' : ''}`}>{running ? <Radio size={21} /> : <Mouse size={21} />}</div><div className="sharing-copy"><div><strong>{running ? 'Seu espaço está conectado' : starting ? 'Conectando seu espaço…' : 'Pronto para conectar'}</strong><Badge tone={running ? 'green' : 'muted'}><span className={`status-dot ${running ? 'online' : ''}`} />{running ? 'Compartilhando' : starting ? 'Iniciando' : 'Pausado'}</Badge></div><p>{state.engine.message || (state.settings.engine.role === 'server' ? 'O mouse e o teclado deste computador vão com você.' : 'Este computador receberá o mouse e o teclado de outro aparelho.')}</p></div><button className={`button ${running ? 'secondary' : 'light'}`} onClick={() => void toggleSharing()} disabled={busy}>{busy || starting ? <LoaderCircle size={15} className="spin" /> : running ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}{running ? 'Pausar' : starting ? 'Cancelar' : 'Iniciar conexão'}</button></div>
          <Workspace state={state} onPair={() => setPairOpen(true)} onLayout={layout => run(async () => setState(await bridge!.setLayout(layout)))} onDevice={showDevice} />
          <div className="below-workspace"><section className="panel devices-panel"><div className="panel-heading compact-heading"><div><h2>Seus dispositivos <span className="count-badge">{paired.length + 1}</span></h2></div><button className="text-button" onClick={() => setPage('devices')}>Ver todos <ArrowUpRight size={14} /></button></div><DeviceRow device={state.local} localId={state.local.id} onClick={() => showDevice(state.local)} />{paired.slice(0, 2).map(device => <DeviceRow key={device.id} device={device} localId={state.local.id} latency={state.latency[device.id]} onClick={() => showDevice(device)} />)}{paired.length === 0 && <button className="empty-device-row" onClick={() => setPairOpen(true)}><span><Plus size={16} /></span><div><strong>Um lugar para o próximo computador</strong><small>Pareie uma vez. Reencontre automaticamente.</small></div><ArrowRight size={16} /></button>}</section><section className="discovery-card"><div className="discovery-orbit"><Radio size={27} /><span className={state.discovery.active ? 'is-searching' : ''} /></div><h3>{state.discovery.active ? 'Sempre de olho na sua rede' : 'Encontre sua próxima tela'}</h3><p>{discovered.length ? `${discovered.length} ${discovered.length === 1 ? 'aparelho disponível' : 'aparelhos disponíveis'} para parear na sua rede.` : 'Seus aparelhos pareados voltam a aparecer, mesmo quando o endereço IP muda.'}</p><button className="text-button" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'spin' : ''} />{refreshing ? 'Buscando…' : 'Buscar dispositivos'}</button></section></div>
          <footer className="workspace-footer"><span><ShieldCheck size={14} /> Pareamento por identidade</span><span><Zap size={14} /> Conexão direta na LAN</span><button onClick={() => setPage('audio')}><Headphones size={14} /> Áudio está no radar <ArrowUpRight size={12} /></button></footer>
        </>}
        {page === 'devices' && <><div className="device-toolbar"><div className="search-field"><Search size={16} /><input aria-label="Buscar dispositivo pelo nome" placeholder="Buscar um dispositivo…" value={query} onChange={event => setQuery(event.target.value)} /></div><button className="button secondary" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'spin' : ''} />{refreshing ? 'Buscando…' : 'Atualizar rede'}</button></div><section className="panel all-devices"><div className="panel-heading compact-heading"><h2>Seu espaço <span className="count-badge">{paired.length + 1}</span></h2><Badge tone="green"><ShieldCheck size={12} /> Identidades salvas</Badge></div>{[state.local, ...paired].filter(device => device.name.toLowerCase().includes(query.toLowerCase())).map(device => <DeviceRow key={device.id} device={device} localId={state.local.id} latency={state.latency[device.id]} onClick={() => showDevice(device)} />)}{![state.local, ...paired].some(device => device.name.toLowerCase().includes(query.toLowerCase())) && <div className="list-empty"><Search size={25} /><h3>Nenhum dispositivo com esse nome</h3><p>Tente outro nome ou limpe a busca.</p></div>}</section><section className="panel all-devices"><div className="panel-heading compact-heading"><h2>Encontrados na rede <span className="count-badge">{discovered.length}</span></h2><span className="subtle-label"><span className={`status-dot ${state.discovery.active ? 'online' : ''}`} />{state.discovery.active ? 'Buscando automaticamente' : 'Descoberta desativada'}</span></div>{discovered.filter(device => device.name.toLowerCase().includes(query.toLowerCase())).map(device => <DeviceRow key={device.id} device={device} localId={state.local.id} onClick={() => showDevice(device)} />)}{discovered.length === 0 && <div className="list-empty"><div className="empty-orbit"><Radio size={28} /></div><h3>Sua próxima tela pode estar por perto</h3><p>Abra o HeyMouse em outro computador conectado à mesma rede.<br />Ele aparecerá aqui para você fazer o pareamento.</p><button className="text-button" onClick={() => setPairOpen(true)}>Já tenho um convite <ArrowRight size={14} /></button></div>}{discovered.length > 0 && !discovered.some(device => device.name.toLowerCase().includes(query.toLowerCase())) && <div className="list-empty"><Search size={25} /><p>Nenhum resultado para essa busca.</p></div>}</section><div className="inline-note devices-note"><LockKeyhole size={16} /><span>Encontrar um aparelho não dá acesso ao seu computador. O compartilhamento exige pareamento e precisa ser iniciado.</span></div></>}
        {page === 'settings' && <SettingsPage state={state} run={run} onState={setState} />}
        {page === 'audio' && <section className="audio-feature panel"><div className="audio-visual"><div className="sound-orbit orbit-one" /><div className="sound-orbit orbit-two" /><div className="sound-orbit orbit-three" /><div className="audio-device audio-device-one"><Monitor size={28} /></div><div className="audio-center"><Headphones size={49} strokeWidth={1.6} /></div><div className="audio-device audio-device-two"><Volume2 size={27} /></div><div className="waveform">{[10, 18, 28, 14, 34, 46, 22, 40, 52, 30, 17, 38, 27, 14, 8].map((height, index) => <span key={index} style={{ height }} />)}</div></div><Badge tone="green">PRÓXIMA ETAPA</Badge><h2>Suas telas conectadas.<br />Seu áudio também, no futuro.</h2><p>Estamos preparando o caminho para enviar o som de um computador para outro pela rede local. Esta versão compartilha mouse e teclado; a transmissão de áudio ainda não está disponível.</p><div className="audio-plan"><span><Network size={17} /> Transmissão pela LAN</span><span><Headphones size={17} /> Escolha da saída de áudio</span><span><Activity size={17} /> Controle de atraso</span></div><button className="button secondary" onClick={() => setPage('connections')}><ArrowLeft size={16} /> Voltar às conexões</button></section>}
      </div>}
    </main>
    {pairOpen && state && <PairDialog onClose={closePair} onState={setState} onError={showError} />}
    {selectedDevice && state && (() => { const device = selectedDevice.id === state.local.id ? state.local : state.devices.find(item => item.id === selectedDevice.id) ?? selectedDevice; const local = device.id === state.local.id; return <Dialog title={device.name} subtitle={`${platformNames[device.platform]} · ${local ? 'Este computador' : device.paired ? 'Aparelho pareado' : 'Encontrado na rede'}`} onClose={closeDevice}><div className="device-detail"><div className="detail-device-top"><span className="detail-device-icon"><PlatformIcon platform={device.platform} size={36} /></span><div><Badge tone={device.online ? 'green' : 'muted'}><span className={`status-dot ${device.online ? 'online' : ''}`} />{device.online ? 'Disponível na rede' : 'Offline'}</Badge><p>{device.hostname}</p></div></div><dl><div><dt>Endereço na rede</dt><dd>{device.addresses.join(', ') || 'Aguardando descoberta'}</dd></div><div><dt>Função</dt><dd>{device.role === 'server' ? 'Compartilha mouse e teclado' : 'Recebe mouse e teclado'}</dd></div><div><dt>Motor de compartilhamento</dt><dd>{device.engineAvailable ? 'Disponível' : 'Não detectado'}</dd></div>{!local && state.latency[device.id] !== undefined && device.online && <div><dt>Tempo de resposta na rede</dt><dd>{state.latency[device.id].toFixed(1)} ms</dd></div>}<div><dt>Identidade permanente</dt><dd className="monospace">{device.id}</dd></div><div><dt>Impressão digital</dt><dd className="monospace fingerprint">{device.fingerprint || 'Disponível após a identificação'}</dd></div></dl>{local ? <button className="button secondary full-width" onClick={() => { closeDevice(); setPage('settings'); }}><Settings2 size={16} /> Configurar este computador</button> : device.paired ? confirmForget ? <div className="forget-confirm"><p>Remover <strong>{device.name}</strong> do seu espaço? Para conectar novamente, será necessário outro convite.</p><div><button className="button secondary" onClick={() => setConfirmForget(false)}>Cancelar</button><button className="button danger" onClick={() => void run(async () => { setState(await bridge!.forgetDevice(device.id)); closeDevice(); })}><Trash2 size={15} /> Remover aparelho</button></div></div> : <button className="button ghost-danger full-width" onClick={() => setConfirmForget(true)}><Trash2 size={15} /> Esquecer dispositivo</button> : <button className="button primary full-width" onClick={() => { closeDevice(); setPairOpen(true); }}><Link2 size={16} /> Parear este aparelho</button>}</div></Dialog>; })()}
    {toast && <div className="toast" role="status"><span>{toast}</span><button className="icon-button" aria-label="Fechar aviso" onClick={() => setToast('')}><X size={17} /></button></div>}
  </div>;
}
