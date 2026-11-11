const audioCfgPrefixLabels: Record<string, string> = {
  'audio/cfg/speakertype/': 'speaker payload',
  'audio/cfg/volumes/': 'volume payload',
  'audio/cfg/playername/': 'player name payload',
  'audio/cfg/playeropts/': 'player options payload',
};

export function formatCommand(command?: string): string {
  if (!command) {
    return '';
  }

  const secureInitPrefix = 'secure/init/';
  if (command.startsWith(secureInitPrefix)) {
    return `${secureInitPrefix}[token redacted, ${
      command.length - secureInitPrefix.length
    } chars]`;
  }

  const secureHelloPrefix = 'secure/hello/';
  if (command.startsWith(secureHelloPrefix)) {
    const payloadLength = Math.max(0, command.length - secureHelloPrefix.length);
    return `${secureHelloPrefix}[payload trimmed, ${payloadLength} chars]`;
  }

  const secureAuthPrefix = 'secure/authenticate/';
  if (command.startsWith(secureAuthPrefix)) {
    return `${secureAuthPrefix}[token redacted, ${
      command.length - secureAuthPrefix.length
    } chars]`;
  }

  const setConfigPrefix = 'audio/cfg/setconfig/';
  if (command.startsWith(setConfigPrefix)) {
    return `${setConfigPrefix}[payload trimmed, ${
      command.length - setConfigPrefix.length
    } chars]`;
  }

  for (const [prefix, label] of Object.entries(audioCfgPrefixLabels)) {
    if (command.startsWith(prefix)) {
      return `${prefix}[${label}, ${command.length - prefix.length} chars]`;
    }
  }

  const max = 320;
  if (command.length > max) {
    return `${command.slice(0, max)}… [truncated ${command.length - max} chars]`;
  }

  return command;
}
