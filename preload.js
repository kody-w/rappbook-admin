const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Store
    store: {
        get: (key) => ipcRenderer.invoke('store:get', key),
        set: (key, value) => ipcRenderer.invoke('store:set', key, value),
        delete: (key) => ipcRenderer.invoke('store:delete', key)
    },

    // GitHub
    github: {
        auth: (token) => ipcRenderer.invoke('github:auth', token),
        logout: () => ipcRenderer.invoke('github:logout'),
        api: (method, endpoint, data) => ipcRenderer.invoke('github:api', method, endpoint, data)
    },

    // RAPP API
    rapp: {
        call: (action, params) => ipcRenderer.invoke('rapp:api', action, params)
    },

    // AI/Copilot
    ai: {
        generate: (prompt, context) => ipcRenderer.invoke('ai:generate', prompt, context)
    },

    // RAPPbook
    rappbook: {
        createPR: (options) => ipcRenderer.invoke('rappbook:createPR', options)
    }
});
