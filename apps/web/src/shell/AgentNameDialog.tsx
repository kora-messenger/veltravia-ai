import { useEffect, useState } from 'react';
import { Button, Dialog, Input } from '../components/ui';
import { MAX_NAME_LENGTH, useAgentProfile } from '../agent/AgentProfileProvider';

/**
 * Naming the assistant.
 *
 * The agent's name is NOT the owner's account name: the account name comes from
 * sign-in and is what the greeting uses. Keeping the two apart here is the
 * point of the dialog, so it edits one field and nothing else.
 *
 * The dialog refuses locally what the server would refuse anyway (an empty
 * name, an over-long one), and it reports a failed save in place instead of
 * closing and pretending the name stuck.
 */
export interface AgentNameDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function AgentNameDialog({ open, onClose }: AgentNameDialogProps) {
  const { agentName, isDefault, saving, save, resetName } = useAgentProfile();
  const [name, setName] = useState(agentName);
  const [problem, setProblem] = useState<string | null>(null);

  // Reopen with whatever the profile currently says, not last time's draft.
  useEffect(() => {
    if (!open) return;
    setName(agentName);
    setProblem(null);
  }, [open, agentName]);

  const trimmed = name.trim();
  const tooLong = [...trimmed].length > MAX_NAME_LENGTH;

  const submit = async () => {
    if (trimmed === '') {
      setProblem('Give your agent a name first.');
      return;
    }
    if (tooLong) {
      setProblem(`Keep it to ${MAX_NAME_LENGTH} characters or fewer.`);
      return;
    }
    const outcome = await save({ agentName: trimmed });
    if (!outcome.ok) {
      setProblem(outcome.message ?? 'The name was not saved.');
      return;
    }
    onClose();
  };

  const restoreDefault = async () => {
    const outcome = await resetName();
    if (!outcome.ok) {
      setProblem(outcome.message ?? 'The default name could not be restored.');
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Name your agent"
      description="This is your agent's name, which is separate from your account name. You can change it whenever you like."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving} disabled={trimmed === '' || tooLong}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          label="Agent name"
          name="agentName"
          value={name}
          maxLength={MAX_NAME_LENGTH * 2}
          disabled={saving}
          autoFocus
          hint={`Up to ${MAX_NAME_LENGTH} characters.`}
          onChange={(event) => {
            setName(event.target.value);
            setProblem(null);
          }}
        />
        {problem !== null && (
          <p className="v-field__error" role="alert">
            {problem}
          </p>
        )}
        {!isDefault && (
          <Button variant="ghost" size="sm" onClick={restoreDefault} disabled={saving}>
            Restore the default name
          </Button>
        )}
      </form>
    </Dialog>
  );
}
