'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowedInvokeChannels = new Set(['app:get-runtime-info', 'recording:authorize', 'recording:save']);

contextBridge.exposeInMainWorld('desktopApi', Object.freeze({
  getRuntimeInfo: () => {
    const channel = 'app:get-runtime-info';
    if (!allowedInvokeChannels.has(channel)) {
      return Promise.reject(new Error('IPC channel is not allowed'));
    }
    return ipcRenderer.invoke(channel);
  },
  authorizeRecording: () => {
    const channel = 'recording:authorize';
    if (!allowedInvokeChannels.has(channel)) {
      return Promise.reject(new Error('IPC channel is not allowed'));
    }
    return ipcRenderer.invoke(channel);
  },
  saveRecording: (arrayBuffer) => {
    const channel = 'recording:save';
    if (!allowedInvokeChannels.has(channel) || !(arrayBuffer instanceof ArrayBuffer)) {
      return Promise.reject(new Error('Invalid recording save request'));
    }
    return ipcRenderer.invoke(channel, arrayBuffer);
  }
}));
