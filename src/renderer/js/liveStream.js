/**
 * LiveStream — sends the candidate's camera to a proctor who opens their inspector.
 * Real video over WebRTC (peer-to-peer on the LAN), negotiated through the proctor
 * WebSocket. Only runs while someone is watching; grid thumbnails stay on the cheap
 * snapshot path in ProctorClient.
 */
(function () {
  'use strict';

  // Host candidates are enough on a LAN; the public STUN entry helps across simple NATs.
  const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const MAX_BITRATE = 700_000;

  const LiveStream = {
    peers: new Map(), // watcherId -> RTCPeerConnection

    send(payload) {
      const ws = window.studentSocket;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    },

    handle(msg) {
      if (msg.type === 'WATCH_REQUEST') this.startWatcher(msg.watcherId);
      else if (msg.type === 'WATCH_STOP') this.stopWatcher(msg.watcherId);
      else if (msg.type === 'RTC_SIGNAL') this.onSignal(msg);
    },

    async startWatcher(watcherId) {
      const stream = window.ProctorClient && window.ProctorClient.stream;
      if (!watcherId || !stream || typeof RTCPeerConnection === 'undefined') return;
      this.stopWatcher(watcherId);

      const pc = new RTCPeerConnection(RTC_CONFIG);
      this.peers.set(watcherId, pc);
      stream.getVideoTracks().forEach(track => {
        const sender = pc.addTrack(track, stream);
        // Cap bitrate so several proctors watching doesn't saturate the candidate's uplink.
        try {
          const params = sender.getParameters();
          params.encodings = [{ ...(params.encodings && params.encodings[0]), maxBitrate: MAX_BITRATE }];
          sender.setParameters(params).catch(() => {});
        } catch (_) {}
      });
      pc.onicecandidate = (e) => {
        if (e.candidate) this.send({ type: 'RTC_SIGNAL', watcherId, candidate: e.candidate });
      };
      pc.onconnectionstatechange = () => {
        if (['failed', 'closed'].includes(pc.connectionState)) this.stopWatcher(watcherId);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send({ type: 'RTC_SIGNAL', watcherId, description: pc.localDescription });
    },

    async onSignal(msg) {
      const pc = this.peers.get(msg.watcherId);
      if (!pc) return;
      try {
        if (msg.description) await pc.setRemoteDescription(msg.description);
        else if (msg.candidate) await pc.addIceCandidate(msg.candidate);
      } catch (err) {
        console.warn('[LiveStream] signalling error:', err.message);
      }
    },

    stopWatcher(watcherId) {
      const pc = this.peers.get(watcherId);
      if (pc) {
        try { pc.close(); } catch (_) {}
        this.peers.delete(watcherId);
      }
    },

    stopAll() {
      [...this.peers.keys()].forEach(id => this.stopWatcher(id));
    }
  };

  window.LiveStream = LiveStream;
})();
