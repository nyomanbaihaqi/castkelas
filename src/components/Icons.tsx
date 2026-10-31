import type { ReactNode } from "react";

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const UsbIcon = () => (
  <Icon>
    <path d="M12 2v14" />
    <path d="m8 6 4-4 4 4" />
    <circle cx="12" cy="19" r="3" />
    <path d="M7 10v2a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2" />
  </Icon>
);

export const QrIcon = () => (
  <Icon>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" />
  </Icon>
);

export const SpeakerIcon = ({ muted }: { muted: boolean }) => (
  <Icon>
    <path d="M11 5 6 9H2v6h4l5 4z" />
    {muted ? <path d="m22 9-6 6M16 9l6 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />}
  </Icon>
);

export const RecordIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8" fill="currentColor" stroke="none" />
  </Icon>
);

export const StopIcon = () => (
  <Icon>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </Icon>
);

export const ProjectorIcon = () => (
  <Icon>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
  </Icon>
);

export const PowerIcon = () => (
  <Icon>
    <path d="M12 2v10" />
    <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
  </Icon>
);
