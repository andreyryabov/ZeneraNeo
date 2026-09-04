import {
    bold,
    cyan,
    dim,
    table,
    usageError,
    write,
    type Command,
    type Context,
} from '@zenera/cli/lib';
import { command as schema } from './schema/command.ts';

// ---------------------------------------------------------------------------
// zen rag — retrieval, by subject
//
// A subject is a kind of corpus with its own index format, its own verbs and
// its own flags. They are not variations on one command: what `list` means to
// an API description is not what it would mean to a folder of notes, and one
// flag table covering both would be twice as long and half as true.
//
// So the only thing settled here is the subject word. Everything after it
// belongs to the subject, which is handed its own arguments with the word
// removed — the same contract the `zen` frame gives this command. There is
// deliberately no spelling that omits the subject: `zen rag search` would have
// to mean one of them, and whichever was chosen would be wrong for the other
// forever.
//
// `help <subject>` is a verb rather than a flag because `--help` never gets
// here: the frame lifts it out of the arguments and answers with this page.
// ---------------------------------------------------------------------------

const SUBJECTS: Record<string, Command> = { schema };

const USAGE = 'zen rag <subject> <command> [args...]';

export const command: Command = {
    summary: 'Retrieval over a corpus: index it, then ask it something.',
    usage: USAGE,
    details: [
        'Subjects',
        ...table(Object.entries(SUBJECTS).map(([name, sub]) => [`  ${name}`, dim(sub.summary)])),
        '',
        ...Object.keys(SUBJECTS).map((name) =>
            dim(`  ${cyan(`zen rag help ${name}`)} — its commands, flags and examples`),
        ),
        '',
        dim(`Credentials come from the ${cyan('zen')} keyring — try ${cyan('zen key ls')}.`),
    ],

    async run(ctx: Context): Promise<void> {
        const [subject, ...rest] = ctx.args;

        if (subject === 'help') {
            return help(rest[0]);
        }
        const chosen = subject ? SUBJECTS[subject] : undefined;
        if (!chosen) {
            throw usageError(
                subject ? `unknown subject "${subject}"` : 'no subject given',
                `expected ${Object.keys(SUBJECTS).join(' or ')} — ${USAGE}`,
            );
        }
        return await chosen.run({ ...ctx, args: rest });
    },
};

/** Laid out as `zen help <command>` lays out this one, so the two pages match. */
function help(subject: string | undefined): void {
    const chosen = subject ? SUBJECTS[subject] : undefined;
    if (!chosen) {
        throw usageError(
            subject ? `unknown subject "${subject}"` : 'which subject',
            `expected ${Object.keys(SUBJECTS).join(' or ')} — zen rag help <subject>`,
        );
    }

    write(bold(chosen.usage));
    write(`\n  ${chosen.summary}`);
    if (chosen.details?.length) {
        write('');
        for (const line of chosen.details) {
            write(line ? `  ${line}` : '');
        }
    }
}
