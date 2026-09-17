# Маняша: позы для прототипа

Генерация: встроенный image_gen. Для каждой позы прикладывать исходный `../manyasha-live.png`, а не результат предыдущей генерации. Полный промпт = общий блок + блок выбранного действия. Исходная картинка используется как idle без повторной генерации.

## Общий блок (для каждой генерации)

```text
Use case: identity-preserve.
Asset type: single transparent PNG pose for a conversational website mascot.
Image 1 is the EDIT TARGET and sole identity/composition reference: Manyasha, the blue-and-white Gzhel ceramic matryoshka mascot with big blue eyes, brown fringe, blue headscarf, headset, gold gavel badge, law book and blue fountain pen, on a silver pedestal.
Edit this exact image, preserving character identity, facial proportions, gaze direction except where specified, glossy ceramic material, intricate blue floral pattern, lighting, camera, frontal view and overall framing. Keep head center, closed mouth center, torso and pedestal anchored to their reference locations. Preserve original landscape aspect ratio, image scale and full uncropped pedestal. Do not recompose or zoom. Render only one character, one pose, no contact sheet.
Background must be genuinely transparent with an alpha channel, not a checkerboard painted into the image; no solid background, no environment or floor. Preserve clean edges.
Keep the book on the viewer's left and the fountain pen on the viewer's right; the two original rounded white mitten-like hands have no separate human fingers. Exactly two arms and two hands, one book, one pen; attached plausible joints, no duplicate or floating objects. Keep book inscription exactly "Федеральный закон - 127" and pedestal inscription exactly "РОССИЯ". No additional text, labels, watermarks, effects, sparkles or speech bubbles.
Keep lips gently closed so a separate mouth animation can be composited later. Only change the requested arm pose and expression.
```

## wave

```text
Action: greeting pose. Lift the viewer-right forearm and white mitten with its pen next to the outside of the right side of the head, like a friendly small wave with a pen. Pen remains securely held, pointing upwards and entirely in the frame. Keep book and viewer-left arm in their original positions, torso and head upright, friendly closed-mouth smile. Raised hand must not overlap the face or microphone.
```

## thinking

```text
Action: thoughtful pose. Bend viewer-right arm so the rounded mitten holding the pen rests near the lower right cheek/chin; the pen tip points upward beside the cheek without crossing the eye or mouth. Subtly raise eyebrows and glance slightly upward, calm thoughtful expression and lips closed. Leave head position, book and left arm, body and pedestal unchanged.
```

## point-book

```text
Action: explaining while pointing to the book. Bring the viewer-right forearm across the front of the torso so its mitten securely holds the pen as a pointer, its nib directed toward the upper inner edge of the open law book on the viewer-left. Keep the book title unobstructed and fully legible; do not cross the mouth with the pen. Calm attentive expression, eyes toward viewer, small closed-mouth smile. Keep head, book, torso and pedestal anchored.
```

## celebrate

```text
Action: restrained joyful success pose. Raise the viewer-right arm with the pen in a small triumphant upward gesture away from the face. Slightly lift the viewer-left book-holding forearm while preserving visible book title. Brighter eyes, gently raised eyebrows and a wider but CLOSED-lip smile. Torso, head and pedestal do not jump, rotate or move. No confetti or extra symbols.
```

## shrug

```text
Action: gentle uncertain shrug. Lift both shoulders slightly and bend both forearms outward a little in a balanced questioning gesture, keeping the open book firmly supported on the viewer-left and the pen firmly held on the viewer-right. Slightly raised inner eyebrows and subtle closed-lip uncertain expression; no sadness caricature. Preserve head center, torso and pedestal positions and keep all props fully in frame.
```

## Ограничения

Это статичные позы, не готовые анимации. Точное совпадение координат и узоров не гарантируется генерацией: перед подключением необходимы проверка наложением и выравнивание. Полноценные кивки требуют движения головы отдельно от тела; CSS-поворот целого PNG наклонит также тело и подставку. Моргание требует отдельных век/кадров. Рот в каждой позе нужно привязать к фактическим координатам лица.
