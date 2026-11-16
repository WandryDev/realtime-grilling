/** One entry of the dev navigator: a screen or a forced state of it. */
export interface DemoLink {
  href: string;
  label: string;
}

export interface DemoGroup {
  links: DemoLink[];
  title: string;
}
