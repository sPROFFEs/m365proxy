import { readConfig } from './config.mjs';
import { invalid } from './errors.mjs';
import { listNamedProfiles, loadNamedProfile, saveNamedProfile, deleteNamedProfile, importLegacyProfile, validateProfileName } from './profile-store.mjs';

function stateOverride(argv) {
  if (!argv.length) return readConfig([], {}).stateDir;
  if (argv.length !== 2 || argv[0] !== '--state-dir' || !argv[1] || argv[1].startsWith('--'))
    throw invalid('Profile commands only accept --state-dir after profile names. Edit the saved profile to change runtime options.');
  return readConfig(argv, {}).stateDir;
}

export async function profileAction(argv, output = console) {
  const sub = argv[0] ?? 'list';
  if (!['list', 'show', 'run', 'delete', 'clone'].includes(sub)) throw invalid('profile subcommand must be list, show, run, delete or clone.');
  const namesNeeded = sub === 'list' ? 0 : sub === 'clone' ? 2 : 1;
  if (argv.length < 1 + namesNeeded) throw invalid(`m365proxy profile ${sub} requires ${namesNeeded} profile name${namesNeeded === 1 ? '' : 's'}.`);
  const names = argv.slice(1, 1 + namesNeeded).map(validateProfileName);
  const stateDir = stateOverride(argv.slice(1 + namesNeeded));
  await importLegacyProfile(stateDir).catch(() => false);
  if (sub === 'list') {
    const profiles = await listNamedProfiles(stateDir);
    output.log(JSON.stringify({ state_dir: stateDir, profiles: profiles.map(({ argv: _argv, ...p }) => p) }, null, 2));
    return { done: true };
  }
  const source = await loadNamedProfile(stateDir, names[0]);
  if (!source) throw invalid(`Profile '${names[0]}' does not exist.`);
  if (sub === 'show') {
    const cfg = readConfig(source, {});
    output.log(JSON.stringify({ name: names[0], port: cfg.port, workspace: cfg.workspaceRoot ?? null, context_mode: cfg.workspaceRoot ? cfg.contextMode : null,
      write_mode: cfg.writeMode, exec_mode: cfg.execMode, context_policy: cfg.contextPolicy, conversation_mode: cfg.conversationMode, channel: cfg.channel, headless: cfg.headless, state_dir: cfg.stateDir, argv: source }, null, 2));
    return { done: true };
  }
  if (sub === 'delete') {
    await deleteNamedProfile(stateDir, names[0]); output.log(`Deleted profile '${names[0]}'. Workspace, Microsoft browser state and backups were not deleted.`); return { done: true };
  }
  if (sub === 'clone') {
    await saveNamedProfile(stateDir, names[1], source, { overwrite: false }); output.log(`Cloned '${names[0]}' to '${names[1]}'.`); return { done: true };
  }
  return { done: false, command: 'serve', config: readConfig(source, {}), profileName: names[0] };
}
