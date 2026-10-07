Interactive demo for publication of "GPU Friendly Laplacian Texture Blending and Tiling".
Note: The implementation is adapted for three.js and WebGL and differs slightly from the presented in publication, 
due to their lack of capability of rendering to mip-maps directly or regenerating mip-maps from a render target, 
needed for dynamic mask creation.

To view it locally, one needs to run a http server, two ways:
1. Run in the folder "python -m http.server"
Navigate to http://127.0.0.1:8000/

(Tested on Windows, Python 2 and Python 3)

2. Open folder in Visual Studio Code and open index.html with a right-click and, for instance, "Open with Five Server".

