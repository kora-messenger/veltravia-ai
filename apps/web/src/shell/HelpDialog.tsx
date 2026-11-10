import { Dialog } from '../components/ui';

/**
 * Help & support.
 *
 * The reference links out to a support centre. Veltravia has no support desk and
 * no address to write to yet, so this answers the questions the app can answer
 * itself, from behaviour that is actually in the build. Every line here is
 * checkable in the code; nothing is a promise about a future feature.
 */
export interface HelpDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const TOPICS: readonly { title: string; body: string }[] = [
  {
    title: 'Credits',
    body: 'Every reply costs credits. The month resets on the 1st, and the workspace sheet shows what you have used against your limit.',
  },
  {
    title: 'Which model answers',
    body: 'Automatic picks a model from the ones connected for the kind of prompt you sent. You can pin one model instead under Settings, then Model routing.',
  },
  {
    title: 'When a reply fails',
    body: 'Your message goes back into the box so you can send it again. Nothing is charged for a request that never answered.',
  },
  {
    title: 'Where your work lives',
    body: 'Chats stay in the drawer under Conversations. Projects keep their files under Projects, and finished work can be downloaded from Files & artifacts.',
  },
];

export function HelpDialog({ open, onClose }: HelpDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Help & support">
      <dl className="v-help">
        {TOPICS.map((topic) => (
          <div key={topic.title} className="v-help__topic">
            <dt>{topic.title}</dt>
            <dd>{topic.body}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
