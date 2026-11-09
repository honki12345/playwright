/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React from 'react';
import './dashboard.css';
import { ChevronLeftIcon, ChevronRightIcon, LockIcon, LockOpenIcon, ReloadIcon, ScreenshotRegionIcon } from './icons';
import { clientToViewport, getImageLayout } from './imageLayout';
import { Recording } from './recording';
import { AnnotateSidebar, AnnotateOverlay } from './annotateView';
import { DebuggerPanel } from './debuggerPanel';

import { ToolbarButton } from '@web/components/toolbarButton';
import { SplitView } from '@web/components/splitView';
import { useMeasureForRef } from '@web/uiUtils';

import type { DashboardModel } from './dashboardModel';

const BUTTONS = ['left', 'middle', 'right'] as const;

async function pickSaveWritable(suggestedName: string, description: string, mime: string, extension: string): Promise<FileSystemWritableFileStream | null> {
  try {
    const handle = await (window as any).showSaveFilePicker({
      suggestedName,
      types: [{ description, accept: { [mime]: [extension] } }],
    });
    return await handle.createWritable();
  } catch {
    return null;
  }
}

function smartUrl(input: string): string {
  const value = input.trim();
  if (!value)
    return value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('about:') || value.startsWith('data:'))
    return value;
  const host = value.split(/[/?#]/, 1)[0];
  const hasDot = host.includes('.');
  const isLocalhost = /^localhost(:\d+)?$/i.test(host);
  const hasPort = /:\d+$/.test(host);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host);
  if (isLocalhost || isIp || (hasPort && !hasDot))
    return 'http://' + value;
  if (hasDot || hasPort)
    return 'https://' + value;
  return 'https://' + host + '.com' + value.slice(host.length);
}

type DashboardProps = {
  model: DashboardModel;
};

export const Dashboard: React.FC<DashboardProps> = ({ model }) => {
  const [, setRevision] = React.useState(0);
  React.useEffect(() => model.subscribe(() => setRevision(r => r + 1)), [model]);

  const { tabs, mode, recording, liveFrame, annotateSession, pendingCapture, debuggerPanelOpen, debuggerPaused, apiCalls } = model.state;
  const interactive = mode === 'interactive';
  const annotateActive = !!annotateSession;
  const selectedFrame = annotateSession?.frames.find(f => f.id === annotateSession.selectedFrameId) ?? null;

  const [flashTick, setFlashTick] = React.useState(0);

  const displayRef = React.useRef<HTMLImageElement>(null);
  const screenRef = React.useRef<HTMLDivElement>(null);
  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const viewportMainRef = React.useRef<HTMLDivElement>(null);
  const browserChromeRef = React.useRef<HTMLDivElement>(null);
  const interactiveBtnRef = React.useRef<HTMLButtonElement>(null);
  const moveThrottleRef = React.useRef(0);
  // Hidden text field that receives keyboard focus for the screen, so that IME
  // composition and clipboard paste work like in a regular text input.
  const keySinkRef = React.useRef<HTMLTextAreaElement>(null);
  // Keys forwarded as keydown that still need a matching keyup.
  const pressedKeysRef = React.useRef(new Set<string>());

  const aspect = liveFrame && liveFrame.viewportWidth && liveFrame.viewportHeight
    ? liveFrame.viewportWidth / liveFrame.viewportHeight
    : null;

  const [viewportRect] = useMeasureForRef(viewportMainRef);

  // Active recording hides the browser chrome so the viewport matches what's
  // being captured.
  const showBrowserChrome = recording?.phase !== 'recording';

  const windowStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    const OUTER_MARGIN = 24;
    const chromeHeight = showBrowserChrome ? (browserChromeRef.current?.offsetHeight ?? 40) : 0;
    const availW = viewportRect.width - OUTER_MARGIN;
    const availH = viewportRect.height - OUTER_MARGIN;
    if (availW <= 0 || availH <= 0)
      return undefined;
    if (aspect === null)
      return { width: availW, height: availH };
    const screenH = availH - chromeHeight;
    let w = availW;
    let h = w / aspect;
    if (h > screenH) {
      h = screenH;
      w = h * aspect;
    }
    return { width: w, height: h + chromeHeight };
  }, [viewportRect, aspect, showBrowserChrome]);

  React.useEffect(() => {
    if (flashTick === 0)
      return;
    const btn = interactiveBtnRef.current;
    if (!btn)
      return;
    btn.classList.remove('flash');
    // Force a reflow so that re-adding the class restarts the animation.
    void btn.offsetWidth;
    btn.classList.add('flash');
    const timer = setTimeout(() => btn.classList.remove('flash'), 2000);
    return () => {
      clearTimeout(timer);
      btn.classList.remove('flash');
    };
  }, [flashTick]);

  React.useEffect(() => {
    if (interactive)
      interactiveBtnRef.current?.classList.remove('flash');
  }, [interactive]);

  function flashInteractiveHint() {
    setFlashTick(tick => tick + 1);
  }

  const onSaveRecording = React.useCallback(async (blob: Blob) => {
    const writable = await pickSaveWritable(`playwright-recording-${Date.now()}.webm`, 'WebM Video', 'video/webm', '.webm');
    if (!writable)
      return;
    await writable.write(blob);
    await writable.close();
    model.discardRecording();
  }, [model]);

  const selectedTab = tabs?.find(t => t.selected);
  const ready = !!selectedTab;

  const [omniboxValue, setOmniboxValue] = React.useState(selectedTab?.url ?? '');
  React.useEffect(() => {
    setOmniboxValue(selectedTab?.url ?? '');
  }, [selectedTab?.url]);

  function imgCoords(e: React.MouseEvent): { x: number; y: number } {
    const vw = liveFrame?.viewportWidth ?? 0;
    const vh = liveFrame?.viewportHeight ?? 0;
    if (!vw || !vh)
      return { x: 0, y: 0 };
    const layout = getImageLayout(displayRef.current);
    if (!layout)
      return { x: 0, y: 0 };
    return clientToViewport(layout, vw, vh, e.clientX, e.clientY);
  }

  function sendMouseEvent(method: 'mousedown' | 'mouseup', e: React.MouseEvent) {
    const { x, y } = imgCoords(e);
    model[method](x, y, BUTTONS[e.button] || 'left');
  }

  function focusKeySink() {
    keySinkRef.current?.focus({ preventScroll: true });
  }

  function onScreenMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    // Keep the IME candidate window next to where the user clicked.
    const sink = keySinkRef.current;
    const screen = screenRef.current;
    if (sink && screen) {
      const rect = screen.getBoundingClientRect();
      sink.style.left = `${e.clientX - rect.left}px`;
      sink.style.top = `${e.clientY - rect.top}px`;
    }
    focusKeySink();
    if (!ready)
      return;
    if (!interactive) {
      flashInteractiveHint();
      return;
    }
    sendMouseEvent('mousedown', e);
  }

  function onScreenMouseUp(e: React.MouseEvent) {
    if (!interactive)
      return;
    e.preventDefault();
    sendMouseEvent('mouseup', e);
  }

  function onScreenMouseMove(e: React.MouseEvent) {
    if (!interactive)
      return;
    const now = Date.now();
    if (now - moveThrottleRef.current < 32)
      return;
    moveThrottleRef.current = now;
    const { x, y } = imgCoords(e);
    model.mousemove(x, y);
  }

  function onScreenWheel(e: React.WheelEvent) {
    if (!interactive)
      return;
    e.preventDefault();
    model.wheel(e.deltaX, e.deltaY);
  }

  function isComposingKey(e: React.KeyboardEvent) {
    return e.nativeEvent.isComposing || e.key === 'Process' || e.keyCode === 229;
  }

  function isPasteShortcut(e: React.KeyboardEvent) {
    return (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'v';
  }

  function releasePressedKeys() {
    for (const key of pressedKeysRef.current)
      model.keyup(key);
    pressedKeysRef.current.clear();
  }

  function onScreenKeyDown(e: React.KeyboardEvent) {
    if (!interactive)
      return;
    // Let the IME compose; the committed text arrives via compositionend.
    if (isComposingKey(e))
      return;
    // Let the browser fire a native paste event; the text arrives via onPaste.
    if (isPasteShortcut(e))
      return;
    e.preventDefault();
    pressedKeysRef.current.add(e.key);
    model.keydown(e.key);
  }

  function onScreenKeyUp(e: React.KeyboardEvent) {
    if (!interactive)
      return;
    e.preventDefault();
    if (!pressedKeysRef.current.delete(e.key))
      return;
    model.keyup(e.key);
  }

  function onScreenCompositionEnd(e: React.CompositionEvent) {
    const text = e.data;
    if (keySinkRef.current)
      keySinkRef.current.value = '';
    if (!interactive || !text)
      return;
    model.insertText(text);
  }

  function onScreenPaste(e: React.ClipboardEvent) {
    e.preventDefault();
    if (!interactive)
      return;
    const text = e.clipboardData.getData('text/plain');
    if (text)
      model.insertText(text);
  }

  function onScreenBlur(e: React.FocusEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null))
      return;
    // Keyups that happen while unfocused (e.g. after Cmd+Tab) never reach us;
    // release everything so the remote page does not keep modifiers held.
    releasePressedKeys();
  }

  React.useEffect(() => {
    if (interactive)
      return;
    for (const key of pressedKeysRef.current)
      model.keyup(key);
    pressedKeysRef.current.clear();
  }, [interactive, model]);

  function onOmniboxKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      const value = smartUrl((e.target as HTMLInputElement).value);
      model.navigate(value);
      e.currentTarget.blur();
    }
  }

  const overlayText = selectedTab ? undefined : 'Select a session';
  const isRecording = recording?.phase === 'recording';
  const showRecording = recording?.phase === 'stopped';
  const modeLabel = annotateActive ? 'Dashboard: annotate' : isRecording ? 'Dashboard: record' : 'Dashboard';

  const overlayOpen = !!selectedFrame;

  let actionPointStyle: React.CSSProperties | undefined;
  if (debuggerPanelOpen && liveFrame?.viewportWidth && liveFrame?.viewportHeight) {
    const call = [...apiCalls].reverse().find(c => c.actionPoint && c.status === 'running');
    if (call?.actionPoint) {
      actionPointStyle = {
        left: `${(call.actionPoint.x / liveFrame.viewportWidth) * 100}%`,
        top: `${(call.actionPoint.y / liveFrame.viewportHeight) * 100}%`,
      };
    }
  }

  return (
    <main className={'dashboard-view' + (interactive ? ' interactive' : '') + (annotateActive ? ' has-annotate-sidebar' : '')} aria-label={modeLabel}>
      <SplitView
        orientation='vertical'
        sidebarSize={260}
        minSidebarSize={140}
        settingName='dashboardActionsPanel'
        sidebarHidden={!debuggerPanelOpen}
        sidebar={<DebuggerPanel model={model} />}
        main={<div className='dashboard-main'>
          {/* Toolbar */}
          <div ref={toolbarRef} className='toolbar' hidden={overlayOpen}>
            <ToolbarButton
              ref={interactiveBtnRef}
              className='mode-toggle mode-interactive'
              title={interactive ? 'Disable interactive mode' : 'Enable interactive mode'}
              toggled={interactive}
              disabled={!ready}
              onClick={() => {
                if (interactive)
                  model.toggleInteractive();
                else
                  model.enterInteractive();
              }}
            >
              {interactive ? <LockOpenIcon /> : <LockIcon />}
            </ToolbarButton>
            <ToolbarButton
              className='mode-annotate'
              title={annotateActive ? 'Add screenshot' : 'Take screenshot'}
              disabled={!ready || pendingCapture}
              onClick={() => {
                if (annotateActive)
                  model.addAnnotateFrame();
                else
                  model.enterAnnotate('user');
              }}
            >
              <ScreenshotRegionIcon />
            </ToolbarButton>
            <ToolbarButton
              className='mode-toggle mode-record'
              title={isRecording ? 'Stop recording' : 'Record video'}
              icon='record'
              toggled={isRecording}
              disabled={!ready || showRecording}
              onClick={() => {
                if (isRecording)
                  model.stopRecording();
                else
                  model.startRecording();
              }}
            >
              {isRecording && <span className='mode-record-label'>Recording...</span>}
            </ToolbarButton>
            <ToolbarButton
              className='mode-toggle mode-debugger'
              title={debuggerPanelOpen ? 'Hide actions panel' : 'Show actions panel'}
              icon='list-unordered'
              toggled={debuggerPanelOpen}
              onClick={() => model.toggleDebuggerPanel()}
            />
            {debuggerPaused && <span className='debugger-paused-label'>Paused</span>}
            <div style={{ flex: 'auto' }}></div>
          </div>

          {/* Viewport */}
          <div className='viewport-wrapper'>
            <div ref={viewportMainRef} className='viewport-main'>
              <div className='browser-window' style={windowStyle}>
                {showBrowserChrome && (
                  <div ref={browserChromeRef} className='browser-chrome'>
                    <button className='nav-btn' title='Back' aria-disabled={!interactive || undefined} onClick={() => {
                      if (!interactive) {
                        flashInteractiveHint();
                        return;
                      }
                      model.back();
                    }}>
                      <ChevronLeftIcon />
                    </button>
                    <button className='nav-btn' title='Forward' aria-disabled={!interactive || undefined} onClick={() => {
                      if (!interactive) {
                        flashInteractiveHint();
                        return;
                      }
                      model.forward();
                    }}>
                      <ChevronRightIcon />
                    </button>
                    <button className='nav-btn' title='Reload' aria-disabled={!interactive || undefined} onClick={() => {
                      if (!interactive) {
                        flashInteractiveHint();
                        return;
                      }
                      model.reload();
                    }}>
                      <ReloadIcon />
                    </button>
                    <div className='omnibox-wrap'>
                      <input
                        id='omnibox'
                        className='omnibox'
                        type='text'
                        placeholder='Search or enter URL'
                        spellCheck={false}
                        autoComplete='off'
                        value={omniboxValue}
                        onChange={e => setOmniboxValue(e.target.value)}
                        onKeyDown={e => {
                          if (!interactive)
                            return;
                          onOmniboxKeyDown(e);
                        }}
                        onFocus={e => {
                          if (!interactive) {
                            flashInteractiveHint();
                            e.target.blur();
                            return;
                          }
                          e.target.select();
                        }}
                        aria-disabled={!interactive || undefined}
                        aria-label={interactive ? 'Search or enter URL' : 'URL input - enable interactive mode to use this field'}
                        readOnly={!interactive}
                      />
                    </div>
                  </div>
                )}
                <div
                  ref={screenRef}
                  className='screen'
                  tabIndex={0}
                  style={{ display: liveFrame ? '' : 'none' }}
                  onMouseDown={onScreenMouseDown}
                  onMouseUp={onScreenMouseUp}
                  onMouseMove={onScreenMouseMove}
                  onWheel={onScreenWheel}
                  onKeyDown={onScreenKeyDown}
                  onKeyUp={onScreenKeyUp}
                  onCompositionEnd={onScreenCompositionEnd}
                  onPaste={onScreenPaste}
                  onBlur={onScreenBlur}
                  onFocus={e => {
                    if (e.target === e.currentTarget)
                      focusKeySink();
                  }}
                  onContextMenu={e => e.preventDefault()}
                >
                  <textarea
                    ref={keySinkRef}
                    className='screen-key-sink'
                    aria-label='Keyboard input'
                    autoComplete='off'
                    autoCorrect='off'
                    autoCapitalize='off'
                    spellCheck={false}
                    tabIndex={-1}
                  />
                  <img
                    ref={displayRef}
                    id='display'
                    className='display'
                    alt='screencast'
                    src={liveFrame ? 'data:image/jpeg;base64,' + liveFrame.data : undefined}
                  />
                  {actionPointStyle && <div className='debugger-action-point' style={actionPointStyle}></div>}
                </div>
                {overlayText && <div className={'screen-overlay' + (liveFrame ? ' has-frame' : '')}><span>{overlayText}</span></div>}
              </div>
            </div>
          </div>
        </div>}
      />
      {selectedFrame && (
        <AnnotateOverlay
          key={selectedFrame.id + (annotateSession?.focusAnnotationId ?? '')}
          model={model}
          frame={selectedFrame}
          focusAnnotationId={annotateSession?.focusAnnotationId}
        />
      )}
      {annotateSession && (
        <AnnotateSidebar
          model={model}
          session={annotateSession}
          onSubmit={() => model.submitAnnotateSession()}
        />
      )}

      {showRecording && recording?.phase === 'stopped' && (
        <Recording
          blob={recording.blob}
          blobUrl={recording.blobUrl}
          onSave={onSaveRecording}
          onClose={() => model.discardRecording()}
        />
      )}
    </main>
  );
};
