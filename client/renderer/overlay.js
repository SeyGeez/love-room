const card = document.getElementById('card');
const gif = document.getElementById('gif');

window.loveRoom.onOverlayShow(({ src }) => {
  gif.onload = () => requestAnimationFrame(() => card.classList.remove('hidden'));
  gif.onerror = () => card.classList.add('hidden');
  gif.src = src;
});
window.loveRoom.onOverlayHide(() => card.classList.add('hidden'));
