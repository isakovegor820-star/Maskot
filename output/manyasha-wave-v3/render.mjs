import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const old = join(root, '..', 'manyasha-wave-v2');
function run(args) {
  const p = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { cwd: root, stdio: 'inherit' });
  if (p.status !== 0) throw new Error(`ffmpeg exited ${p.status}`);
}
const order = [
  '00', '00-01', '01', '01-02', '02', '02-03', '03', '03-04', '04',
  '04-05', '05', '05-06', '06', '06-02', '07', '01-02', '08', '00-01', '09',
];
for (const [i, name] of order.entries()) {
  const src = name.includes('-') ? join(root, 'inbetweens', `${name}.png`) : join(old, 'keyframes', `frame-${name}.png`);
  if (!existsSync(src)) throw new Error(`Missing source: ${src}`);
  copyFileSync(src, join(root, 'keyframes', `frame-${String(i).padStart(2, '0')}.png`));
}

// Preserve original anchors and timing: old poses at 0,.3,.6,...,2.7s;
// new in-betweens at .15,.45,.75,...,2.55s. Last pose holds until 3s.
// This is video compositing; generated PNGs are preserved unchanged.
const threshold = 'if(lt(Y,420),995,if(lt(Y,470),995-(Y-420)*0.9,950))';
const mask = `255*clip((X-(${threshold}))/14,0,1)*clip((Y-70)/18,0,1)*clip((820-Y)/24,0,1)`;
const clean = "scale=1452:1084:flags=lanczos,format=rgba,lut=a='if(lt(val,220),0,255)'";
const graph = [
  `[0:v]${clean}[moving]`, `[1:v]${clean}[fixed]`,
  '[2:v]format=rgba,split=2[bg1][bg2]',
  '[bg1][moving]overlay=shortest=1:format=auto,format=gbrp[movingflat]',
  '[bg2][fixed]overlay=shortest=1:format=auto,format=gbrp[fixedflat]',
  `[3:v]format=gbrp,geq=r='${mask}':g='${mask}':b='${mask}'[mask]`,
  '[fixedflat][movingflat][mask]maskedmerge=planes=7,scale=960:718:flags=lanczos,pad=1080:810:60:46:color=0x111018,setsar=1,format=yuv420p[out]',
].join(';');
run([
  '-framerate', '20/3', '-start_number', '0', '-i', 'keyframes/frame-%02d.png',
  '-loop', '1', '-framerate', '20/3', '-i', 'keyframes/frame-00.png',
  '-f', 'lavfi', '-i', 'color=c=0x111018:s=1452x1084:r=20/3',
  '-f', 'lavfi', '-i', 'color=c=black:s=1452x1084:r=20/3',
  '-filter_complex', graph, '-map', '[out]', '-frames:v', '19', '-an', '-c:v', 'ffv1', 'keyframes-locked.mkv',
]);
const encode = ['-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-frames:v', '90'];
run([
  '-i', 'keyframes-locked.mkv', '-vf',
  'tpad=start_mode=clone:start_duration=0.15:stop_mode=clone:stop_duration=0.6,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:me=umh:search_param=128:vsbmc=1:scd=none,trim=start=0.15:duration=3,setpts=PTS-STARTPTS',
  ...encode, 'manyasha-wave-19.mp4',
]);
run(['-i', 'keyframes-locked.mkv', '-vf', 'tpad=stop_mode=clone:stop_duration=0.3,fps=30,trim=duration=3,setpts=PTS-STARTPTS', ...encode, 'manyasha-wave-19-clean.mp4']);
run(['-i', 'manyasha-wave-19.mp4', '-vf', 'setpts=2*PTS,fps=30', '-an', '-c:v', 'libx264', '-crf', '18', '-movflags', '+faststart', 'qa/manyasha-wave-19-slow.mp4']);
const font = '/System/Library/Fonts/Supplemental/Arial.ttf';
const labels = existsSync(font) ? `,drawtext=fontfile=${font}:text='10 poses — previous':fontcolor=white:fontsize=25:x=32:y=12,drawtext=fontfile=${font}:text='19 poses — new':fontcolor=white:fontsize=25:x=752:y=12` : '';
run([
  '-i', join(old, 'manyasha-wave.mp4'), '-i', 'manyasha-wave-19.mp4',
  '-filter_complex', `[0:v]scale=720:540,pad=720:588:0:48:color=0x111018[l];[1:v]scale=720:540,pad=720:588:0:48:color=0x111018[r];[l][r]hstack=inputs=2${labels}[out]`,
  '-map', '[out]', ...encode, 'comparison-10-vs-19.mp4',
]);
run([
  '-i', 'keyframes-locked.mkv', '-vf', "drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='%{eif\\:n+1\\:d\\:2}':fontcolor=white:fontsize=42:x=24:y=24,scale=270:202,tile=5x4:padding=8:margin=8:color=0x111018",
  '-frames:v', '1', '-update', '1', 'qa/storyboard-19.png',
]);
run(['-i', 'manyasha-wave-19.mp4', '-vf', 'fps=10,scale=270:202,tile=6x5:padding=4:margin=4:color=0x111018', '-frames:v', '1', '-update', '1', 'qa/interpolated-contact.png']);
run(['-i', 'comparison-10-vs-19.mp4', '-vf', 'fps=5,scale=720:294,tile=3x5:padding=4:margin=4:color=0x111018', '-frames:v', '1', '-update', '1', 'qa/comparison-contact.png']);
console.log('Rendered 19-pose test, clean stepped reference and side-by-side comparison.');
