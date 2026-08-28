import { useState } from "react";
import { sanitizeDisplayName } from "../name";

export function NameGate({
  onContinue,
}: {
  onContinue: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const displayName = sanitizeDisplayName(name);

  return (
    <main className="name-gate">
      <form
        className="name-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (displayName) onContinue(displayName);
        }}
      >
        <p className="eyebrow">Shared Paseo session</p>
        <h2>What should we call you?</h2>
        <p>Choose a name so the room can show who is here.</p>
        <label>
          Your name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            autoFocus
            maxLength={40}
            placeholder="Your name"
          />
        </label>
        <button type="submit" disabled={!displayName}>
          Join room
        </button>
      </form>
    </main>
  );
}
