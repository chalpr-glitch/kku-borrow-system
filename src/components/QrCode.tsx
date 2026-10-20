'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

interface QrCodeProps {
  value: string;
  size?: number;
  className?: string;
  level?: 'L' | 'M' | 'Q' | 'H';
  includeMargin?: boolean;
}

export function QRCodeCanvas({
  value,
  size = 180,
  className = '',
  level = 'M',
  includeMargin = true,
}: QrCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current || !value) return;
    QRCode.toCanvas(
      canvasRef.current,
      value,
      {
        width: size,
        margin: includeMargin ? 2 : 0,
        errorCorrectionLevel: level,
        color: {
          dark: '#1e293b',
          light: '#ffffff',
        },
      },
      (err) => {
        if (err) console.error('QR Code render error:', err);
      }
    );
  }, [value, size, level, includeMargin]);

  return <canvas ref={canvasRef} className={`rounded-lg ${className}`} />;
}

export function QRCodeImage({
  value,
  size = 180,
  className = '',
  alt = 'QR Code',
}: {
  value: string;
  size?: number;
  className?: string;
  alt?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string>('');

  useEffect(() => {
    if (!value) return;
    QRCode.toDataURL(value, {
      width: size * 2, // 2x retina
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#1e293b',
        light: '#ffffff',
      },
    })
      .then(setDataUrl)
      .catch(console.error);
  }, [value, size]);

  if (!dataUrl) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex items-center justify-center bg-slate-100 text-xs text-slate-400 rounded-lg animate-pulse"
      >
        กำลังสร้าง QR...
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={dataUrl}
      alt={alt}
      width={size}
      height={size}
      className={`rounded-lg ${className}`}
    />
  );
}

export async function getQrDataUrl(value: string, size = 300): Promise<string> {
  return QRCode.toDataURL(value, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#1e293b',
      light: '#ffffff',
    },
  });
}
