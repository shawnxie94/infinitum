import type { ReactNode } from "react";

type IconProps = {
  size?: number;
  strokeWidth?: number;
  className?: string;
};

type IconBaseProps = IconProps & {
  children: ReactNode;
};

function IconBase({ size = 16, strokeWidth = 2, className, children }: IconBaseProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.04.04a2 2 0 0 1-1.42 3.42h-.1a1.7 1.7 0 0 0-1.66 1.18l-.02.07a2 2 0 0 1-3.83 0l-.02-.07a1.7 1.7 0 0 0-1.66-1.18h-.1a2 2 0 0 1-1.42-3.42l.04-.04A1.7 1.7 0 0 0 4.6 15a2 2 0 0 1 0-6 1.7 1.7 0 0 0-.34-1.87l-.04-.04A2 2 0 0 1 5.64 3.67h.1a1.7 1.7 0 0 0 1.66-1.18l.02-.07a2 2 0 0 1 3.83 0l.02.07a1.7 1.7 0 0 0 1.66 1.18h.1a2 2 0 0 1 1.42 3.42l-.04.04A1.7 1.7 0 0 0 19.4 9a2 2 0 0 1 0 6Z" />
    </IconBase>
  );
}

export function IconSun(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="M4.93 4.93l1.41 1.41" />
      <path d="M17.66 17.66l1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="M4.93 19.07l1.41-1.41" />
      <path d="M17.66 6.34l1.41-1.41" />
    </IconBase>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z" />
    </IconBase>
  );
}

export function IconMonitor(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </IconBase>
  );
}

export function IconLogout(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </IconBase>
  );
}

export function IconLock(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </IconBase>
  );
}

export function IconTag(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 10V6a2 2 0 0 0-2-2h-4l-8 8a2 2 0 0 0 0 2.83l3.17 3.17a2 2 0 0 0 2.83 0l8-8Z" />
      <circle cx="15" cy="7" r="1.5" />
    </IconBase>
  );
}

export function IconList(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </IconBase>
  );
}

export function IconGrip(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="9" cy="5" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="19" r="1" />
    </IconBase>
  );
}

export function IconRobot(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="4" y="7" width="16" height="12" rx="2" />
      <path d="M12 3v4" />
      <circle cx="9" cy="13" r="1" />
      <circle cx="15" cy="13" r="1" />
      <path d="M9 17h6" />
    </IconBase>
  );
}

export function IconNote(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
    </IconBase>
  );
}

export function IconPlug(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 7v4" />
      <path d="M15 7v4" />
      <path d="M7 11h10" />
      <path d="M12 11v6" />
      <path d="M8 21h8" />
      <path d="M9 3h6" />
    </IconBase>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4" />
      <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4" />
      <path d="M3 5v4h4" />
      <path d="M21 19v-4h-4" />
    </IconBase>
  );
}

export function IconFilter(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 5h16l-6 7v5l-4 2v-7Z" />
    </IconBase>
  );
}

export function IconFlame(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 22a7 7 0 0 0 7-7c0-2.6-1.3-4.9-3.7-6.8-.6 2-1.7 3.2-3.3 3.8.7-3.5-.8-6.4-4.2-8.7.2 3.5-.8 5.8-3 7.7A6.4 6.4 0 0 0 5 21.1" />
      <path d="M12 22a3 3 0 0 0 3-3c0-1.3-.8-2.5-2.4-3.7-.2 1.4-.9 2.3-2 2.8.1-1.4-.4-2.7-1.5-3.8A4.1 4.1 0 0 0 9 20.9" />
    </IconBase>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </IconBase>
  );
}

export function IconArrowDown(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 5v14M5 12l7 7 7-7" />
    </IconBase>
  );
}

export function IconArrowUp(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </IconBase>
  );
}

export function IconThumbsUp(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M7 10v12" />
      <path d="M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 8a2 2 0 0 1-2 1.7H7" />
      <path d="M7 10H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
      <path d="M14 10V5a3 3 0 0 0-3-3l-4 8" />
    </IconBase>
  );
}

export function IconThumbsDown(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M17 14V2" />
      <path d="m9 18.1 1-4.1H4.2a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.6 2H17" />
      <path d="M17 14h3a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2h-3" />
      <path d="M10 14v5a3 3 0 0 0 3 3l4-8" />
    </IconBase>
  );
}

export function IconLink(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 1 0-7.07-7.07L10 5" />
      <path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 1 0 7.07 7.07L14 19" />
    </IconBase>
  );
}

export function IconClock(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </IconBase>
  );
}

export function IconShield(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    </IconBase>
  );
}

export function IconGlobe(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18" />
      <path d="M12 3a15 15 0 0 0 0 18" />
    </IconBase>
  );
}

export function IconEdit(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </IconBase>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 5v14M5 12h14" />
    </IconBase>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 6 9 17l-5-5" />
    </IconBase>
  );
}

export function IconCircleHelp(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.75 9a2.25 2.25 0 1 1 3.86 1.58c-.7.7-1.61 1.17-1.61 2.42" />
      <path d="M12 16.5h.01" />
    </IconBase>
  );
}

export function IconX(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </IconBase>
  );
}

export function IconEye(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" />
      <circle cx="12" cy="12" r="3" />
    </IconBase>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.7 21.7 0 0 1 5.06-5.94" />
      <path d="M1 1l22 22" />
      <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a21.7 21.7 0 0 1-4.46 5.52" />
      <path d="M14.12 14.12a3 3 0 0 1-4.24-4.24" />
    </IconBase>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </IconBase>
  );
}

export function IconRotateCw(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </IconBase>
  );
}

export function IconSquare(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </IconBase>
  );
}

export function IconExternalLink(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </IconBase>
  );
}

export function IconGithub(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 19c-5 1.5-5-2.5-7-3" />
      <path d="M14 22v-3.4a3.4 3.4 0 0 0-.9-2.4c3 0 6-1.4 6-6a4.5 4.5 0 0 0-1.2-3.3 4.2 4.2 0 0 0-.1-3.1s-1-.3-3.3 1.2a11.5 11.5 0 0 0-6 0C6.2 2.9 5.2 3.2 5.2 3.2a4.2 4.2 0 0 0-.1 3.1A4.5 4.5 0 0 0 3.9 9.6c0 4.6 3 6 6 6a3.4 3.4 0 0 0-.9 2.3V22" />
    </IconBase>
  );
}

export function IconRss(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="6" cy="18" r="1.5" />
      <path d="M4.5 11.5a8 8 0 0 1 8 8" />
      <path d="M4.5 6.5a13 13 0 0 1 13 13" />
    </IconBase>
  );
}

export function IconMerge(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 6h8" />
      <path d="M6 12h4" />
      <path d="M14 12h4" />
      <path d="M8 6v6c0 1.1.9 2 2 2h4c1.1 0 2-.9 2-2V6" />
      <path d="M12 14v6" />
    </IconBase>
  );
}

export function IconSplit(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 4v5" />
      <path d="M12 15v5" />
      <path d="M5 9h14" />
      <path d="M7 15h10" />
      <path d="M9 9v2a4 4 0 0 0 4 4" />
      <path d="M15 9v2a4 4 0 0 1-4 4" />
    </IconBase>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </IconBase>
  );
}

export function IconClose(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </IconBase>
  );
}

export function IconType(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 19V7h8v12" />
      <path d="M4 12h8" />
      <path d="M14 19V11h6v8" />
      <path d="M14 15h6" />
    </IconBase>
  );
}
