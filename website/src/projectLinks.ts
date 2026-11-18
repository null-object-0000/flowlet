const repository = "https://github.com/null-object-0000/flowlet";
const docs = `${repository}/blob/main/docs`;

export const projectLinks = {
  repository,
  releases: `${repository}/releases`,
  docker: `${docs}/docker.md`,
  compatibility: `${docs}/support-matrix.md`,
} as const;
