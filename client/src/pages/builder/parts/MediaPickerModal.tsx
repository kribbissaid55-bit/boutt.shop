import { useEffect, useRef, useState } from 'react';
import { Upload, Image as ImageIcon, Mic, Video, FileText } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../../api/client';
import { useI18n } from '../../../i18n';
import { Modal } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';
import { Empty } from '../../../components/ui/Empty';

type Media = { id: string; name: string; type: string; mimeType: string; sizeBytes: number };

export function MediaPickerModal({ open, kindFilter, onClose, onPick }: {
  open: boolean;
  kindFilter?: 'image' | 'audio' | 'video' | 'document';
  onClose: () => void;
  onPick: (mediaId: string) => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Media[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const accept = (() => {
    switch (kindFilter) {
      case 'image': return 'image/*,.jpg,.jpeg,.png,.webp,.gif';
      case 'audio': return 'audio/*,.mp3,.m4a,.ogg,.opus,.wav,.aac,.amr,.flac,.aiff';
      case 'video': return 'video/*,.mp4,.mov,.webm,.3gp';
      case 'document': return 'application/pdf,.pdf,.doc,.docx';
      default: return '*';
    }
  })();

  const load = async () => {
    const all = await api.get<Media[]>('/media');
    setItems(kindFilter ? all.filter((m) => m.type === kindFilter) : all);
  };
  useEffect(() => { if (open) load(); }, [open, kindFilter]);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const m = await api.upload<Media>('/media', file);
      toast.success(t.media.uploaded);
      onPick(m.id);
    } catch (err: any) {
      toast.error(err?.message ?? t.app.error);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t.builder.block_pick_media} wide
      footer={
        <>
          <input ref={fileRef} type="file" className="hidden" onChange={onUpload} accept={accept} />
          <Button variant="secondary" onClick={() => fileRef.current?.click()} loading={busy}>
            <Upload size={14} /> {t.media.upload}
          </Button>
          <Button variant="ghost" onClick={onClose}>{t.app.cancel}</Button>
        </>
      }>
      {items.length === 0 ? <Empty /> : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {items.map((m) => {
            const Icon = m.type === 'image' ? ImageIcon : m.type === 'audio' ? Mic : m.type === 'video' ? Video : FileText;
            return (
              <button key={m.id} onClick={() => onPick(m.id)} className="rounded-lg border border-gray-200 p-2 text-start hover:border-brand-500">
                {m.type === 'image' ? (
                  <img src={`/api/media/${m.id}/raw`} className="h-24 w-full rounded object-cover" />
                ) : m.type === 'video' ? (
                  <video src={`/api/media/${m.id}/raw`} className="h-24 w-full rounded bg-black" />
                ) : (
                  <div className="flex h-24 items-center justify-center rounded bg-gray-50"><Icon className="text-gray-400" /></div>
                )}
                <div className="mt-1 truncate text-xs">{m.name}</div>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
