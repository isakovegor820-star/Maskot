import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
function run(args) {
  const p = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y', ...args], { cwd: root, stdio: 'inherit' });
  if (p.status !== 0) throw new Error(`ffmpeg exited ${p.status}`);
}
for (let i = 0; i < 10; i++) {
  const path = join(root, 'keyframes', `frame-${String(i).padStart(2, '0')}.png`);
  if (!existsSync(path)) throw new Error(`Missing keyframe: ${path}`);
}

// Video compositing: the original face, book and pedestal remain fixed.
// Only the region swept by the right arm comes from generated keyframes.
// The boundary moves outside the head above y=430, then follows the shoulder.
const threshold = 'if(lt(Y,420),995,if(lt(Y,470),995-(Y-420)*0.9,950))';
const mask = `255*clip((X-(${threshold}))/14,0,1)*clip((Y-70)/18,0,1)*clip((820-Y)/24,0,1)`;
const clean = "scale=1452:1084:flags=lanczos,format=rgba,lut=a='if(lt(val,220),0,255)'";
const graph = [
  `[0:v]${clean}[moving]`,
  `[1:v]${clean}[fixed]`,
  '[2:v]format=rgba,split=2[bg1][bg2]',
  '[bg1][moving]overlay=shortest=1:format=auto,format=gbrp[movingflat]',
  '[bg2][fixed]overlay=shortest=1:format=auto,format=gbrp[fixedflat]',
  `[3:v]format=gbrp,geq=r='${mask}':g='${mask}':b='${mask}'[mask]`,
  '[fixedflat][movingflat][mask]maskedmerge=planes=7,scale=960:718:flags=lanczos,pad=1080:810:60:46:color=0x111018,setsar=1,format=yuv420p[out]',
].join(';');
run([
  '-framerate', '10/3', '-start_number', '0', '-i', 'keyframes/frame-%02d.png',
  '-loop', '1', '-framerate', '10/3', '-i', 'keyframes/frame-00.png',
  '-f', 'lavfi', '-i', 'color=c=0x111018:s=1452x1084:r=10/3',
  '-f', 'lavfi', '-i', 'color=c=black:s=1452x1084:r=10/3',
  '-filter_complex', graph, '-map', '[out]', '-frames:v', '10',
  '-an', '-c:v', 'ffv1', 'keyframes-locked.mkv',
]);
run([
  '-i', 'keyframes-locked.mkv',
  '-vf', 'tpad=start_mode=clone:start_duration=0.3:stop_mode=clone:stop_duration=0.6,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:me=umh:search_param=128:vsbmc=1:scd=none,trim=start=0.3:duration=3,setpts=PTS-STARTPTS',
  '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', '-frames:v', '90', 'manyasha-wave.mp4',
]);
// Clean stepped reference: the original 10 poses, with no synthetic in-betweens.
run([
  '-i', 'keyframes-locked.mkv', '-vf', 'fps=30', '-an',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', '-frames:v', '90', 'manyasha-wave-keyframes.mp4',
]);
// Inspect actual encoded video at 2x slow motion without changing the master.
run([
  '-i', 'manyasha-wave.mp4', '-vf', 'setpts=2*PTS,fps=30', '-an',
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-movflags', '+faststart',
  'qa/manyasha-wave-slow.mp4',
]);
run([
  '-i', 'keyframes-locked.mkv', '-vf', 'scale=270:202,tile=5x2:padding=8:margin=8:color=0x111018',
  '-frames:v', '1', '-update', '1', 'qa/keyframes-contact.png',
]);
run([
  '-i', 'manyasha-wave.mp4', '-vf', 'fps=10,scale=270:202,tile=6x5:padding=4:margin=4:color=0x111018',
  '-frames:v', '1', '-update', '1', 'qa/interpolated-contact.png',
]);
console.log('Rendered 3-second wave and QA previews. Source PNGs preserved.');
