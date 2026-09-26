require('dotenv').config();
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const simpleGit = require('simple-git');

// Starts the tiny web server UptimeRobot will ping.
require('./keep_alive');

const PREFIX = '.';
const TEMP_DIR = path.join(__dirname, 'temp');
// Unzip your Prometheus download here so this folder contains cli.lua directly.
const PROMETHEUS_DIR = path.join(__dirname, 'Prometheus');
// Local clone of the GitHub repo you want obfuscated scripts pushed to.
const REPO_DIR = path.join(__dirname, 'repo');

const {
  DISCORD_TOKEN,
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH = 'main',
  PROMETHEUS_PRESET = 'Medium',
} = process.env;

for (const [key, val] of Object.entries({ DISCORD_TOKEN, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO })) {
  if (!val) console.warn(`Warning: env var missing (${key}). Check your .env / Replit Secrets.`);
}

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Clones the target repo once, on first push, using a token-authenticated remote URL.
async function ensureRepoCloned() {
  if (fs.existsSync(path.join(REPO_DIR, '.git'))) return;
  const remote = `https://${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;
  const git = simpleGit();
  await git.clone(remote, REPO_DIR, ['--branch', GITHUB_BRANCH]);
}

async function downloadAttachment(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download attachment: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

// Prometheus is run from its own folder so it can find its internal modules.
function runPrometheus(inputPath) {
  const cliPath = path.join(PROMETHEUS_DIR, 'cli.lua');
  const cmd = `lua "${cliPath}" --preset ${PROMETHEUS_PRESET} "${inputPath}"`;
  return execAsync(cmd, { cwd: PROMETHEUS_DIR });
}

// Prometheus's default output naming: your_file.lua -> your_file.obfuscated.lua
function getObfuscatedPath(inputPath) {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}.obfuscated${parsed.ext}`);
}

async function pushToGithub(localFilePath, repoRelativePath) {
  await ensureRepoCloned();
  const destPath = path.join(REPO_DIR, repoRelativePath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(localFilePath, destPath);

  const git = simpleGit(REPO_DIR);
  await git.add(repoRelativePath);
  await git.commit(`Add obfuscated script: ${repoRelativePath}`);
  await git.push('origin', GITHUB_BRANCH);

  return `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${repoRelativePath}`;
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  if (command !== 'obfuscate') return;

  const mode = args[0] && args[0].toLowerCase() === 'load' ? 'load' : 'plain';

  const attachment = message.attachments.first();
  if (!attachment) {
    return message.reply('Attach the `.lua` file you want to obfuscate.');
  }
  if (!attachment.name.toLowerCase().endsWith('.lua')) {
    return message.reply('Only `.lua` files are supported.');
  }

  const statusMsg = await message.reply('Obfuscating...');

  const jobId = Date.now().toString();
  const jobDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const inputPath = path.join(jobDir, attachment.name);

  try {
    await downloadAttachment(attachment.url, inputPath);
    await runPrometheus(inputPath);

    const obfPath = getObfuscatedPath(inputPath);
    if (!fs.existsSync(obfPath)) {
      throw new Error('Prometheus produced no output file — check the Lua install and preset name.');
    }

    if (mode === 'load') {
      const repoRelativePath = `scripts/${jobId}-${attachment.name}`;
      const rawUrl = await pushToGithub(obfPath, repoRelativePath);
      const loadstring = `loadstring(game:HttpGet("${rawUrl}"))()`;
      await statusMsg.edit({ content: `Done. Loadstring:\n\`\`\`lua\n${loadstring}\n\`\`\`` });
    } else {
      const file = new AttachmentBuilder(obfPath, { name: `obfuscated-${attachment.name}` });
      await statusMsg.edit({ content: 'Done. Here is your obfuscated script:', files: [file] });
    }
  } catch (err) {
    console.error(err);
    await statusMsg.edit(`Something went wrong: \`${err.message}\``);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

client.login(DISCORD_TOKEN);
