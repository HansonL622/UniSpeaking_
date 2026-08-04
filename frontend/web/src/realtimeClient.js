const DEFAULT_API_BASE = "";
const DEFAULT_USER_ID = "local-demo-user";
const DEFAULT_VOICE = "Katerina";
const DATA_CHANNEL_LABEL = "oai-events";

const eventId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return "";
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("后端地址必须使用 HTTP 或 HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function websocketUrl(baseUrl) {
  const origin = baseUrl || window.location.origin;
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/session-events";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function unwrapResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = body?.message || body?.error || body?.code || `后端请求失败（${response.status}）`;
    throw new Error(message);
  }
  if (body && typeof body === "object" && "success" in body) {
    if (!body.success) throw new Error(body.message || body.code || "后端请求失败");
    return body.data ?? null;
  }
  return body;
}

function normalizeSdp(sdp) {
  const normalized = String(sdp || "").trim().replace(/\r?\n/g, "\r\n");
  return normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
}

function waitForIceGathering(peer) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("ICE 候选收集超时")), 10_000);
    const previous = peer.onicegatheringstatechange;
    peer.onicegatheringstatechange = () => {
      previous?.();
      if (peer.iceGatheringState === "complete") {
        window.clearTimeout(timer);
        resolve();
      }
    };
  });
}

function waitForChannel(channel) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("实时数据通道连接超时")), 10_000);
    channel.onopen = () => {
      window.clearTimeout(timer);
      resolve();
    };
    channel.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("实时数据通道连接失败"));
    };
  });
}

function providerSessionId(event) {
  return event?.providerSessionId
    || event?.provider_session_id
    || event?.session_id
    || event?.session?.id
    || null;
}

function shouldForwardProviderEvent(type) {
  return [
    "session.created",
    "session.updated",
    "conversation.item.input_audio_transcription.completed",
    "response.audio_transcript.done",
    "error",
  ].includes(type);
}

export function createRealtimeClient({
  apiBase = import.meta.env.VITE_UNISPEAKING_API_BASE || DEFAULT_API_BASE,
  onEvent = () => {},
  onRemoteStream = () => {},
} = {}) {
  const base = normalizeBaseUrl(apiBase);
  const eventsUrl = websocketUrl(base);
  let peer = null;
  let channel = null;
  let eventSocket = null;
  let localStream = null;
  let audioSender = null;
  let localSessionId = null;
  let sessionConfig = null;
  let muted = false;
  let paused = false;
  let started = false;

  const emit = (event) => onEvent(event);

  function setTrackEnabled() {
    const track = localStream?.getAudioTracks?.()[0];
    if (track) track.enabled = started && !muted && !paused;
  }

  function connectEventSocket(sessionId) {
    if (eventSocket?.readyState === WebSocket.OPEN) return Promise.resolve(eventSocket);
    if (eventSocket?.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve, reject) => {
        eventSocket.addEventListener("open", () => resolve(eventSocket), { once: true });
        eventSocket.addEventListener("error", () => reject(new Error("事件 WebSocket 连接失败")), { once: true });
      });
    }
    eventSocket = new WebSocket(eventsUrl);
    eventSocket.onmessage = (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (event.type === "webrtc.close" && event.localSessionId === sessionId) {
        void stop({ notifyBackend: false, reason: event.reason || "后端要求关闭 WebRTC" });
      }
    };
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("事件 WebSocket 连接超时")), 5_000);
      eventSocket.onopen = () => {
        window.clearTimeout(timer);
        resolve(eventSocket);
      };
      eventSocket.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("事件 WebSocket 连接失败"));
      };
    });
  }

  async function sendBackendEvent(type, payload = {}) {
    if (!localSessionId) return { ignored: true };
    const socket = await connectEventSocket(localSessionId);
    const event = {
      eventId: payload.event_id || payload.eventId || eventId("evt"),
      type,
      localSessionId,
      sceneSessionId: localSessionId,
      providerSessionId: providerSessionId(payload),
      occurredAt: new Date().toISOString(),
      payload,
    };
    socket.send(JSON.stringify(event));
    return { sent: true };
  }

  function sendProviderEvent(event) {
    if (!channel || channel.readyState !== "open") {
      throw new Error("实时数据通道尚未连接");
    }
    channel.send(JSON.stringify(event));
  }

  async function postStart({ offerSdp, topic, userId }) {
    const response = await fetch(`${base}/api/scene-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: userId || DEFAULT_USER_ID,
        offerSdp,
        topic: topic || undefined,
        provider: "QWEN",
        voice: DEFAULT_VOICE,
        translationEnabled: true,
      }),
    });
    return unwrapResponse(response);
  }

  async function handleProviderEvent(raw) {
    let event;
    try {
      event = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      emit({ type: "local.error", message: "收到无法解析的模型事件" });
      return;
    }

    emit(event);
    if (shouldForwardProviderEvent(event.type)) {
      await sendBackendEvent(event.type, event).catch(() => {});
    }

    if (event.type === "session.created") {
      started = true;
      const audioTrack = localStream?.getAudioTracks?.()[0];
      if (audioTrack && audioSender?.track !== audioTrack) {
        await audioSender?.replaceTrack(audioTrack);
      }
      setTrackEnabled();
      sendProviderEvent({ event_id: eventId("config"), type: "session.update", session: sessionConfig });
      return;
    }

    if (event.type === "session.updated") {
      sendProviderEvent({ event_id: eventId("response"), type: "response.create" });
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      await sendBackendEvent("session.interrupted", { type: "session.interrupted", source: event }).catch(() => {});
    }
  }

  async function start({ topic = "", userId = DEFAULT_USER_ID } = {}) {
    if (peer) return { localSessionId };
    emit({ type: "local.connecting" });

    try {
      peer = new RTCPeerConnection();
      peer.ontrack = (event) => {
        const stream = event.streams?.[0];
        if (stream) onRemoteStream(stream);
      };
      peer.onconnectionstatechange = () => {
        emit({ type: "local.connection_state", state: peer?.connectionState });
        if (["failed", "disconnected", "closed"].includes(peer?.connectionState)) {
          if (peer?.connectionState !== "closed") {
            void sendBackendEvent("error", { type: "error", code: "WEBRTC_CONNECTION_CLOSED", message: "WebRTC 连接已断开" }).catch(() => {});
          }
        }
      };

      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const audioTrack = localStream.getAudioTracks()[0];
      audioTrack.enabled = false;
      audioSender = peer.addTrack(audioTrack, localStream);
      await audioSender.replaceTrack(null);

      channel = peer.createDataChannel(DATA_CHANNEL_LABEL);
      channel.onmessage = (message) => { void handleProviderEvent(message.data); };
      peer.ondatachannel = (event) => {
        const incoming = event.channel;
        incoming.onmessage = (message) => { void handleProviderEvent(message.data); };
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);

      const backend = await postStart({ offerSdp: peer.localDescription?.sdp || offer.sdp || "", topic, userId });
      localSessionId = backend.localSessionId;
      sessionConfig = {
        modalities: ["text", "audio"],
        voice: backend.voiceId || DEFAULT_VOICE,
        instructions: backend.systemPrompt || topic || "",
        input_audio_transcription: { model: "gummy-realtime-v1" },
        turn_detection: { type: "server_vad" },
      };

      await connectEventSocket(localSessionId);
      await peer.setRemoteDescription({ type: "answer", sdp: normalizeSdp(backend.answerSdp) });
      await waitForChannel(channel);
      emit({ type: "local.connected", localSessionId, backend });
      return { localSessionId, backend };
    } catch (error) {
      await stop({ notifyBackend: false, reason: "start_failed" });
      emit({ type: "local.error", message: error instanceof Error ? error.message : "无法开始实时对话" });
      throw error;
    }
  }

  function setMuted(value) {
    muted = Boolean(value);
    setTrackEnabled();
    emit({ type: "local.muted", muted });
    return muted;
  }

  async function pause() {
    paused = true;
    setTrackEnabled();
    await sendBackendEvent("session.paused", { type: "session.paused" }).catch(() => {});
    emit({ type: "local.paused" });
  }

  async function resume() {
    paused = false;
    setTrackEnabled();
    await sendBackendEvent("session.resumed", { type: "session.resumed" }).catch(() => {});
    emit({ type: "local.resumed" });
  }

  async function interrupt() {
    await sendBackendEvent("session.interrupted", { type: "session.interrupted" }).catch(() => {});
    emit({ type: "local.interrupted" });
  }

  async function stop({ notifyBackend = true, reason = "user_stop" } = {}) {
    if (notifyBackend) {
      await sendBackendEvent("session.completed", { type: "session.completed", reason }).catch(() => {});
    }
    try { channel?.close?.(); } catch { /* already closed */ }
    try { eventSocket?.close?.(); } catch { /* already closed */ }
    try { peer?.close?.(); } catch { /* already closed */ }
    localStream?.getTracks?.().forEach((track) => track.stop());
    peer = null;
    channel = null;
    eventSocket = null;
    localStream = null;
    audioSender = null;
    localSessionId = null;
    sessionConfig = null;
    started = false;
    paused = false;
    muted = false;
    emit({ type: "local.ended", reason });
  }

  return {
    start,
    handleEvent: handleProviderEvent,
    pause,
    resume,
    interrupt,
    stop,
    setMuted,
    isActive: () => Boolean(peer || localSessionId),
  };
}
