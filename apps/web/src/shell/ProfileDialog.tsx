import { useEffect, useState } from 'react';
import { Button, Dialog, Input } from '../components/ui';
import { MAX_NAME_LENGTH, useAgentProfile } from '../agent/AgentProfileProvider';

/**
 * Who you are, and what your assistant is called.
 *
 * Two separate names, kept apart on purpose: the owner's name is the person
 * using Veltravia, the agent name is the assistant. Both are real fields on the
 * profile API, so this dialog writes what it shows instead of pretending.
 *
 * The reference puts an email at the top of its profile block. Veltravia has no
 * accounts yet, so there is no address to show; the person's name is what the
 * workspace is actually built on.
 */
export interface ProfileDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function ProfileDialog({ open, onClose }: ProfileDialogProps) {
  const { agentName, ownerName, saving, save } = useAgentProfile();
  const [name, setName] = useState(ownerName ?? '');
  const [assistant, setAssistant] = useState(agentName);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(ownerName ?? '');
    setAssistant(agentName);
    setProblem(null);
  }, [open, ownerName, agentName]);

  const yourName = name.trim();
  const assistantName = assistant.trim();
  const tooLong =
    [...yourName].length > MAX_NAME_LENGTH || [...assistantName].length > MAX_NAME_LENGTH;

  const submit = async () => {
    if (yourName === '') {
      setProblem('Add your name first.');
      return;
    }
    if (assistantName === '') {
      setProblem('Give your assistant a name first.');
      return;
    }
    if (tooLong) {
      setProblem(`Keep each name to ${MAX_NAME_LENGTH} characters or fewer.`);
      return;
    }
    const outcome = await save({ ownerName: yourName, agentName: assistantName });
    if (!outcome.ok) {
      setProblem(outcome.message ?? 'Your profile was not saved.');
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Your profile"
      description="Your name is what your workspace is called after. Your assistant has its own name."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving} disabled={yourName === '' || assistantName === ''}>
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
          label="Your name"
          name="ownerName"
          value={name}
          maxLength={MAX_NAME_LENGTH * 2}
          disabled={saving}
          autoFocus
          onChange={(event) => {
            setName(event.target.value);
            setProblem(null);
          }}
        />
        <Input
          label="Your assistant's name"
          name="agentName"
          value={assistant}
          maxLength={MAX_NAME_LENGTH * 2}
          disabled={saving}
          hint={`Up to ${MAX_NAME_LENGTH} characters.`}
          onChange={(event) => {
            setAssistant(event.target.value);
            setProblem(null);
          }}
        />
        {problem !== null && (
          <p className="v-field__error" role="alert">
            {problem}
          </p>
        )}
      </form>
    </Dialog>
  );
}
