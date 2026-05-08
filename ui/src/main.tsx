import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { GatewayBrowserClient, readLocalToken, type GatewayEvent } from "./gateway-browser-client";
import "./styles.css";

function App() {
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [message, setMessage] = useState("");

  async function submit() {
    const token = await readLocalToken();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const client = new GatewayBrowserClient({ url: `${protocol}//${location.host}/ws`, token });
    await client.connect();
    client.submitTurn(
      {
        sessionKey: `web:project=${location.pathname || "default"}:default`,
        channelKey: "web",
        message,
      },
      (event) => setEvents((existing) => [...existing, event]),
    );
    setMessage("");
  }

  return (
    <main>
      <h1>PolitDeck</h1>
      <section className="conversation">
        {events.map((event, index) => (
          <pre key={index}>{renderEvent(event)}</pre>
        ))}
      </section>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ask PolitDeck..." />
        <button type="submit">Send</button>
      </form>
    </main>
  );
}

function renderEvent(event: GatewayEvent): string {
  if (event.type === "assistant_text_delta") return event.text;
  if (event.type === "error") return `Error: ${event.message}`;
  return `[${event.type}]`;
}

createRoot(document.getElementById("root")!).render(<App />);
