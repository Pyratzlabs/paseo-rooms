/* Shared-room chat client. Renders the Paseo timeline: history from the REST
   endpoint, then live agent_stream events over the room WebSocket. */

const token = location.pathname.split("/").filter(Boolean)[1];
const $ = (id) => document.getElementById(id);
const timelineEl = $("timeline");

const nameInput = $("name");
nameInput.value = localStorage.getItem("paseo-rooms-name") || "";
nameInput.addEventListener("change", () => localStorage.setItem("paseo-rooms-name", nameInput.value));

let openAssistant = null; // current streaming assistant bubble
let openReasoning = null;

function scrolledToBottom() {
  return timelineEl.scrollHeight - timelineEl.scrollTop - timelineEl.clientHeight < 60;
}
function append(el) {
  const stick = scrolledToBottom();
  timelineEl.appendChild(el);
  if (stick) timelineEl.scrollTop = timelineEl.scrollHeight;
}

function bubble(cls, text) {
  const div = document.createElement("div");
  div.className = "msg " + cls;
  div.textContent = text;
  append(div);
  return div;
}

function metaLine(text) {
  const div = document.createElement("div");
  div.className = "meta";
  div.textContent = text;
  append(div);
  return div;
}

function closeStreams() {
  openAssistant = null;
  openReasoning = null;
}

function renderUserMessage(text) {
  closeStreams();
  // Attribution convention: messages sent through a room are "[Name]\n<text>".
  const match = text.match(/^\[([^\]\n]{1,40})\]\n([\s\S]*)$/);
  const div = bubble("user", match ? match[2] : text);
  const author = document.createElement("span");
  author.className = "author";
  author.textContent = match ? match[1] : "host";
  div.prepend(author);
}

function renderItem(item) {
  switch (item.type) {
    case "user_message":
      renderUserMessage(item.text);
      break;
    case "assistant_message":
      // Live assistant output arrives in pieces; concatenate into one bubble.
      if (!openAssistant) openAssistant = bubble("assistant", "");
      openAssistant.textContent += item.text;
      openReasoning = null;
      break;
    case "reasoning":
      if (!openReasoning) openReasoning = bubble("assistant reasoning", "");
      openReasoning.textContent += item.text;
      openAssistant = null;
      break;
    case "tool_call":
      closeStreams();
      metaLine(`⚙ ${item.name} — ${item.status}`);
      break;
    case "todo": {
      closeStreams();
      const lines = (item.items || []).map(
        (t) => `${t.completed || t.status === "completed" ? "☑" : "☐"} ${t.text}`,
      );
      metaLine(lines.join("\n"));
      break;
    }
    default:
      break;
  }
}

function renderStreamEvent(event) {
  switch (event.type) {
    case "timeline":
      renderItem(event.item);
      break;
    case "turn_started":
      $("working").style.display = "block";
      break;
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled":
      $("working").style.display = "none";
      closeStreams();
      if (event.type === "turn_failed") metaLine(`✗ turn failed: ${event.error}`);
      break;
    case "permission_requested":
      metaLine("⚠ the agent is asking for permission — the host must respond in Paseo");
      break;
    default:
      break;
  }
}

async function loadRoom() {
  const res = await fetch(`/api/rooms/${token}`);
  if (!res.ok) {
    $("error").style.display = "block";
    timelineEl.style.display = "none";
    $("form").style.display = "none";
    $("working").style.display = "none";
    return false;
  }
  const room = await res.json();
  $("title").textContent = room.label || "Shared session";
  if (room.agent) {
    $("status").textContent = `${room.agent.provider ?? ""} · ${room.agent.status ?? ""}`;
    if (room.agent.status === "running") $("working").style.display = "block";
  }
  return true;
}

async function loadHistory() {
  const res = await fetch(`/api/rooms/${token}/history`);
  if (!res.ok) return;
  const { entries } = await res.json();
  timelineEl.replaceChildren();
  closeStreams();
  for (const entry of entries) {
    renderItem(entry.item);
    closeStreams(); // history entries are already merged; one bubble per entry
  }
  timelineEl.scrollTop = timelineEl.scrollHeight;
}

function connectLive() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${token}/ws`);
  ws.onopen = () => {
    $("live").textContent = "● live";
    $("live").style.color = "seagreen";
    // Re-sync: anything that streamed while we were disconnected is in history.
    loadHistory();
  };
  ws.onmessage = (msg) => {
    const frame = JSON.parse(msg.data);
    if (frame.type === "stream") renderStreamEvent(frame.event);
  };
  ws.onclose = () => {
    $("live").textContent = "○ reconnecting…";
    $("live").style.color = "darkorange";
    setTimeout(connectLive, 1500);
  };
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = $("message").value.trim();
  const name = nameInput.value.trim();
  if (!message) return;
  if (!name) {
    nameInput.focus();
    return;
  }
  $("message").value = "";
  const res = await fetch(`/api/rooms/${token}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, name }),
  });
  if (!res.ok) metaLine("✗ failed to send message");
  // No local echo: the message comes back through the shared timeline stream.
});

$("message").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("form").requestSubmit();
  }
});

loadRoom().then((ok) => {
  if (ok) connectLive();
});
