import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/auth-context';

export const metadata: Metadata = {
  metadataBase: new URL('https://borrowoas.web.app'),
  title: {
    default: 'ระบบยืม-คืนครุภัณฑ์ | สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น',
    template: '%s | ระบบยืม-คืนครุภัณฑ์ สำนักบริการวิชาการ มข.',
  },
  description:
    'ระบบยืม-คืนครุภัณฑ์ สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น (KKU OAS Equipment Borrowing System)',
  icons: {
    icon: '/icon.png',
    shortcut: '/favicon.ico',
    apple: '/branding/oas-kku-logo.png',
  },
  openGraph: {
    title: 'ระบบยืม-คืนครุภัณฑ์ | สำนักบริการวิชาการ มข.',
    description:
      'ระบบบริหารจัดการ ยืมและคืนครุภัณฑ์ อุปกรณ์โสตทัศนูปกรณ์ คอมพิวเตอร์ สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น',
    url: 'https://borrowoas.web.app',
    siteName: 'KKU OAS Borrowing System',
    images: [
      {
        url: '/branding/oas-kku-logo.png',
        width: 750,
        height: 450,
        alt: 'ตราสัญลักษณ์สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น',
      },
    ],
    locale: 'th_TH',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Prompt:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400;1,600&family=Sarabun:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-dvh bg-slate-50/70 font-sans text-slate-800 antialiased selection:bg-brand-500 selection:text-white">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
