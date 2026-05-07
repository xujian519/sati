export type RoutedSlashCommand = {
  commandName: string
  args: string
  routed: boolean
}

/**
 * Supports two-level turnkey invocations:
 *   /turnkey start ...
 *   /turnkey onboard
 * and rewrites them to canonical plugin command names:
 *   /turnkey:start ...
 *   /turnkey:onboard
 */
export function routeTurnkeySubcommand(
  commandName: string,
  args: string,
  hasCommandByName: (name: string) => boolean,
): RoutedSlashCommand {
  if (commandName.toLowerCase() !== 'turnkey') {
    return { commandName, args, routed: false }
  }

  const trimmedArgs = args.trim()
  if (!trimmedArgs) {
    return { commandName, args, routed: false }
  }

  const [subcommandRaw, ...restArgs] = trimmedArgs.split(/\s+/)
  const subcommand = subcommandRaw.toLowerCase()
  const candidateCommand = `turnkey:${subcommand}`

  if (!hasCommandByName(candidateCommand)) {
    return { commandName, args, routed: false }
  }

  return {
    commandName: candidateCommand,
    args: restArgs.join(' '),
    routed: true,
  }
}
