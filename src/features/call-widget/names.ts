/** "Ольги и Игоря", "Натальи", "Сергея, Анны и Елены". */
export function joinNames(names: string[]) {
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} и ${names.at(-1)}`;
}
