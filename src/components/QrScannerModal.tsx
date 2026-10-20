'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Html5Qrcode } from 'html5-qrcode';
import {
  Camera,
  X,
  FlipHorizontal,
  Upload,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  ScanLine,
} from 'lucide-react';

interface QrScannerModalProps {
  open: boolean;
  onClose: () => void;
  onScan?: (decodedText: string) => void;
  onScanResult?: (decodedText: string) => void;
  title?: string;
  hint?: string;
}

export default function QrScannerModal({
  open,
  onClose,
  onScan,
  onScanResult,
  title = 'สแกน QR Code เพื่อยืม / ส่งมอบ / คืน',
  hint = 'วางตำแหน่ง QR Code ให้อยู่ภายในกรอบสแกน',
}: QrScannerModalProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'camera' | 'file'>('camera');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [scanning, setScanning] = useState(false);
  const [scanSuccessText, setScanSuccessText] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isLockedRef = useRef(false);

  const qrRegionId = 'qr-reader-region';

  // Smart Parser for QR Codes
  const handleDecodedText = (decodedText: string) => {
    if (isLockedRef.current) return;
    isLockedRef.current = true;
    setScanSuccessText(decodedText);

    // Audio beep feedback if supported
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = 880;
      gain.gain.value = 0.1;
      osc.start();
      setTimeout(() => {
        osc.stop();
        audioCtx.close();
      }, 120);
    } catch {
      // Audio context might be restricted
    }

    const scanCb = onScan || onScanResult;
    if (scanCb) {
      setTimeout(() => {
        try {
          scanCb(decodedText);
        } catch (e) {
          console.error('Scan callback error:', e);
        }
        onClose();
      }, 500);
      return;
    }

    // Default Router Logic
    setTimeout(() => {
      onClose();
      const text = decodedText.trim();

      try {
        // 1. Is URL?
        if (text.startsWith('http://') || text.startsWith('https://')) {
          const url = new URL(text);
          if (url.pathname.includes('/borrow')) {
            const eq = url.searchParams.get('eq') || url.searchParams.get('item') || '';
            router.push(eq ? `/borrow/?eq=${encodeURIComponent(eq)}` : '/borrow/');
            return;
          }
          if (url.pathname.includes('/request')) {
            const id = url.searchParams.get('id') || '';
            router.push(id ? `/request/?id=${encodeURIComponent(id)}` : '/my-requests/');
            return;
          }
          if (url.pathname.includes('/catalog')) {
            const item = url.searchParams.get('item') || url.searchParams.get('eq') || '';
            router.push(item ? `/borrow/?eq=${encodeURIComponent(item)}` : '/equipment/');
            return;
          }
          if (url.pathname.includes('/equipment')) {
            const item = url.searchParams.get('item') || url.searchParams.get('eq') || '';
            const q = url.searchParams.get('q') || '';
            if (item) {
              router.push(`/borrow/?eq=${encodeURIComponent(item)}`);
            } else if (q) {
              router.push(`/equipment/?q=${encodeURIComponent(q)}`);
            } else {
              router.push('/equipment/');
            }
            return;
          }
        }

        // 2. Is Request ID (BR-YYYYMM-XXXX)
        if (text.startsWith('BR-')) {
          router.push(`/request/?id=${encodeURIComponent(text)}`);
          return;
        }

        // 3. Is Equipment ID or Asset Number
        if (text.startsWith('EQ-') || text.startsWith('KKU-OAS-') || text.startsWith('KKU-')) {
          router.push(`/borrow/?eq=${encodeURIComponent(text)}`);
          return;
        }

        // 4. Default: Search in Equipment Catalog
        router.push(`/equipment/?q=${encodeURIComponent(text)}`);
      } catch (err) {
        console.error('Navigation error after QR scan:', err);
        router.push(`/equipment/?q=${encodeURIComponent(text)}`);
      }
    }, 600);
  };

  // Start Camera Scanner
  useEffect(() => {
    if (!open || activeTab !== 'camera') {
      if (scannerRef.current && scanning) {
        try {
          scannerRef.current
            .stop()
            .catch((e) => console.warn('Scanner stop error:', e))
            .finally(() => {
              scannerRef.current = null;
              setScanning(false);
            });
        } catch (e) {
          scannerRef.current = null;
          setScanning(false);
        }
      }
      return;
    }

    setCameraError(null);
    setScanSuccessText(null);
    isLockedRef.current = false;

    let html5QrCode: Html5Qrcode;
    try {
      html5QrCode = new Html5Qrcode(qrRegionId);
      scannerRef.current = html5QrCode;
    } catch (err: any) {
      setCameraError('ไม่สามารถเริ่มต้นกล้องได้: ' + err.message);
      return;
    }

    Html5Qrcode.getCameras()
      .then((devices) => {
        if (!devices || !devices.length) {
          setCameraError('ไม่พบกล้องในอุปกรณ์ของคุณ กรุณาใช้วิธีอัปโหลดรูปภาพแทน');
          return;
        }
        setCameras(devices);
        const backCamera = devices.find(
          (d) =>
            d.label.toLowerCase().includes('back') ||
            d.label.toLowerCase().includes('rear') ||
            d.label.toLowerCase().includes('environment')
        );
        const camId = selectedCameraId || (backCamera ? backCamera.id : devices[0].id);
        setSelectedCameraId(camId);

        return html5QrCode.start(
          camId,
          {
            fps: 15,
            qrbox: { width: 250, height: 250 },
            aspectRatio: 1.0,
          },
          (decodedText) => {
            handleDecodedText(decodedText);
            try {
              if (html5QrCode && html5QrCode.isScanning) {
                html5QrCode.stop().catch(() => {});
              }
            } catch (e) {}
          },
          () => {
            // Ignore frame parse errors
          }
        );
      })
      .then(() => {
        setScanning(true);
      })
      .catch((err) => {
        console.error('Camera start error:', err);
        setCameraError(
          'กรุณาอนุญาตการเข้าถึงกล้อง (Camera Permission) ในเบราว์เซอร์ของคุณ หรือลองใช้วิธีอัปโหลดภาพ QR Code'
        );
      });

    return () => {
      if (html5QrCode && html5QrCode.isScanning) {
        html5QrCode.stop().catch(console.warn);
      }
    };
  }, [open, activeTab, selectedCameraId]);

  // Handle Switch Camera
  const handleSwitchCamera = () => {
    if (cameras.length <= 1) return;
    const currentIndex = cameras.findIndex((c) => c.id === selectedCameraId);
    const nextIndex = (currentIndex + 1) % cameras.length;
    setSelectedCameraId(cameras[nextIndex].id);
  };

  // Handle File Upload QR Scan
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileError(null);

    try {
      const html5QrCode = new Html5Qrcode('qr-file-region');
      const decodedText = await html5QrCode.scanFile(file, true);
      handleDecodedText(decodedText);
    } catch (err: any) {
      setFileError('ไม่พบ QR Code ในรูปภาพนี้ หรือภาพไม่ชัดเจน (' + (err.message || 'โปรดลองถ่ายภาพใหม่ให้ตรงและชัดเจนขึ้น') + ')');
    }
  };

  // Handle Escape key and body scroll lock
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="relative w-full max-w-md overflow-hidden rounded-3xl bg-slate-900 text-white shadow-2xl border border-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 p-4">
          <div className="flex items-center gap-2">
            <div className="rounded-xl bg-brand-600 p-2 text-white">
              <ScanLine className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white">{title}</h3>
              <p className="text-[11px] text-slate-400">{hint}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-800 p-1.5 text-slate-400 hover:bg-slate-700 hover:text-white transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab switch: Camera vs Upload */}
        <div className="flex border-b border-slate-800 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setActiveTab('camera')}
            className={`flex-1 py-2.5 text-center transition flex items-center justify-center gap-1.5 ${
              activeTab === 'camera'
                ? 'border-b-2 border-brand-500 text-white bg-slate-800/50 font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Camera className="h-4 w-4" /> สแกนผ่านกล้อง
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('file')}
            className={`flex-1 py-2.5 text-center transition flex items-center justify-center gap-1.5 ${
              activeTab === 'file'
                ? 'border-b-2 border-brand-500 text-white bg-slate-800/50 font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Upload className="h-4 w-4" /> อัปโหลดรูปภาพ QR
          </button>
        </div>

        {/* Scanner Body */}
        <div className="p-5 flex flex-col items-center justify-center min-h-[340px]">
          {activeTab === 'camera' ? (
            <div className="w-full space-y-4">
              {cameraError ? (
                <div className="rounded-2xl bg-rose-950/50 border border-rose-800 p-4 text-center space-y-2 text-xs text-rose-200">
                  <AlertCircle className="mx-auto h-8 w-8 text-rose-400" />
                  <div className="font-bold text-sm text-white">ไม่สามารถเปิดกล้องได้</div>
                  <p>{cameraError}</p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('file')}
                    className="btn-primary bg-rose-600 hover:bg-rose-700 text-xs py-1.5 px-3 mt-2"
                  >
                    สลับไปใช้วิธีอัปโหลดรูปภาพ
                  </button>
                </div>
              ) : (
                <div className="relative overflow-hidden rounded-2xl bg-black border-2 border-slate-700 aspect-square flex items-center justify-center">
                  <div id={qrRegionId} className="w-full h-full" />

                  {/* Scan Laser Guide Line Animation */}
                  {scanning && !scanSuccessText && (
                    <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 bg-gradient-to-r from-transparent via-brand-400 to-transparent animate-pulse shadow-[0_0_8px_#ef4444]" />
                  )}

                  {/* Success Overlay */}
                  {scanSuccessText && (
                    <div className="absolute inset-0 bg-emerald-950/90 flex flex-col items-center justify-center p-4 text-center space-y-2 animate-in fade-in">
                      <CheckCircle2 className="h-12 w-12 text-emerald-400 animate-bounce" />
                      <div className="font-bold text-base text-white">สแกนสำเร็จ!</div>
                      <div className="font-mono text-xs text-emerald-200 break-all max-w-[240px]">
                        {scanSuccessText}
                      </div>
                      <div className="text-xs text-emerald-300">กำลังนำคุณไปยังหน้ารายการ...</div>
                    </div>
                  )}
                </div>
              )}

              {/* Camera Switcher Button */}
              {cameras.length > 1 && (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={handleSwitchCamera}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3.5 py-2 text-xs font-semibold text-slate-300"
                  >
                    <FlipHorizontal className="h-4 w-4" /> สลับกล้องหน้า/หลัง
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="w-full space-y-4 text-center">
              <div id="qr-file-region" className="hidden" />
              <div
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label="คลิกเพื่อเลือกไฟล์รูปภาพ QR Code"
                className="cursor-pointer rounded-2xl border-2 border-dashed border-slate-700 hover:border-brand-500 bg-slate-800/40 p-8 flex flex-col items-center justify-center gap-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <div className="rounded-2xl bg-brand-600/20 p-4 text-brand-400">
                  <Upload className="h-8 w-8" />
                </div>
                <div>
                  <div className="text-sm font-bold text-white">คลิกเพื่อเลือกไฟล์รูปภาพ QR Code</div>
                  <div className="text-xs text-slate-400 mt-1">รองรับ JPG, PNG, WebP</div>
                </div>
              </div>

              {fileError && (
                <div className="rounded-2xl bg-rose-950/60 border border-rose-800 p-3.5 text-xs text-rose-200 text-left flex items-start gap-2 animate-in fade-in">
                  <AlertCircle className="h-4 w-4 text-rose-400 flex-shrink-0 mt-0.5" />
                  <span>{fileError}</span>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileUpload}
              />
            </div>
          )}
        </div>

        {/* Footer info */}
        <div className="border-t border-slate-800 bg-slate-950/60 p-3 text-center text-[11px] text-slate-400">
          💡 สแกนได้ทั้ง QR Code บนตัวครุภัณฑ์ และ QR Code บนหน้าจอมือถือผู้ยืม
        </div>
      </div>
    </div>
  );
}
