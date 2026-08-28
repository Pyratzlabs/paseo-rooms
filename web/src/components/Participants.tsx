import type { RoomParticipant } from "../api";

export function Participants({
  participants,
}: {
  participants: RoomParticipant[];
}) {
  return (
    <aside className="participants" aria-label="People in this room">
      <div className="participants-heading">
        <span>People</span>
        <span>{participants.length}</span>
      </div>
      <ul>
        {participants.map((participant) => (
          <li key={participant.id} className={participant.role}>
            <span className="participant-avatar" aria-hidden="true">
              {participant.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="participant-name">{participant.name}</span>
            {participant.role === "host" && (
              <span className="participant-role">Host</span>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
