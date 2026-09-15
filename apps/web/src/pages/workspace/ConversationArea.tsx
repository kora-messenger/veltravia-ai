import type { ReactNode } from 'react';
import { ORIGIN_LABELS, type WorkspaceMessageView } from './message-model';

export interface ConversationAreaProps {
  /** Messages to render. Empty until Step 11C-2 wires the agent API. */
  messages: readonly WorkspaceMessageView[];
}

/**
 * The AI conversation surface. Renders the Veltravia introduction when the
 * conversation is empty, and otherwise renders messages with an explicit
 * origin so users can always tell who produced what — user content,
 * assistant content, system status, and tool output look different.
 *
 * All message text renders as plain React text nodes. It is never
 * interpreted as HTML or executed.
 */
export function ConversationArea({ messages }: ConversationAreaProps) {
  if (messages.length === 0) {
    return (
      <div className="v-conversation v-conversation--empty" aria-label="Conversation">
        <div className="v-workspace-intro">
          <div className="v-workspace-intro__logo" aria-hidden="true">
            V
          </div>
          <h2 className="v-workspace-intro__title">Build with Veltravia AI</h2>
          <p className="v-workspace-intro__description">
            Describe what you want to create, change, analyze, or improve in this project. Veltravia
            plans the work, shows you every action, and asks before anything risky happens.
          </p>
          <ul className="v-workspace-intro__examples">
            <li>Add a login page with email verification</li>
            <li>Explain what the main modules do</li>
            <li>Find slow spots in the data layer</li>
            <li>Turn the settings screen into a dark-ready layout</li>
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="v-conversation" aria-label="Conversation">
      <ol className="v-conversation__list" role="list">
        {messages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
      </ol>
    </div>
  );
}

const ORIGIN_CLASS: Record<WorkspaceMessageView['origin'], string> = {
  user: 'v-msg v-msg--user',
  assistant: 'v-msg v-msg--assistant',
  system: 'v-msg v-msg--system',
  tool: 'v-msg v-msg--tool',
};

function MessageRow({ message }: { message: WorkspaceMessageView }): ReactNode {
  return (
    <li className={ORIGIN_CLASS[message.origin]}>
      {message.origin !== 'user' && (
        <span className="v-msg__origin">{ORIGIN_LABELS[message.origin]}</span>
      )}
      {message.source !== undefined && <span className="v-msg__source">{message.source}</span>}
      <div className="v-msg__body">{message.text}</div>
    </li>
  );
}
