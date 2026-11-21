/** The author and committer of a commit Orchestra makes, set on the command line so no config can change it. */

export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

/** `-c` options naming the identity. author.* and committer.* outrank user.* in the user's own config. */
export function identityArgs(id: CommitIdentity): string[] {
  return ['user', 'author', 'committer'].flatMap((who) => ['-c', `${who}.name=${id.name}`, '-c', `${who}.email=${id.email}`]);
}
