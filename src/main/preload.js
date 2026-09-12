'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// Narrow surface on purpose: the pill gets exactly the calls it needs and no
// filesystem, no shell, no arbitrary IPC.
contextBridge.exposeInMainWorld('voice', {
  // The window is larger than the shape drawn in it, so the page has to tell main
  // when the pointer is genuinely over that shape; otherwise the overlay would eat
  // clicks across a wide invisible rectangle.
  setInteractive: wants => ipcRenderer.send('overlay:interactive', !!wants),

  // Lets the pill label its own hint with the real hotkey instead of hardcoding it.
  onConfig: cb => ipcRenderer.on('config', (_e, cfg) => cb(cfg)),

  // Cursor position in window coords, polled by main because Electron will not
  // forward mousemove to a transparent non-focusable click-through window.
  onPointer: cb => ipcRenderer.on('pointer', (_e, pt) => cb(pt)),

  // Dragging: the renderer reports the grab offset, main moves the window and
  // tracks the physical mouse button (the cursor leaves the window immediately).
  dragStart: offset => ipcRenderer.send('drag:start', offset),
  onDragEnd: cb => ipcRenderer.on('drag:end', () => cb()),

  onCommand: cb => ipcRenderer.on('pill:command', (_e, cmd) => cb(cmd)),
  pillState: state => ipcRenderer.send('pill:state', state),
  transcribe: payload => ipcRenderer.invoke('pill:transcribe', payload),
  // Separate channel from transcribe: a memo is filed to disk, never inserted.
  memo: payload => ipcRenderer.invoke('pill:memo', payload),
  // invoke, not send: a paste that silently fails is worse than no paste, so the
  // renderer needs the result back to show an error.
  insert: text => ipcRenderer.invoke('pill:insert', text),
})
