import build_main, build_rest
import os
P=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..')+'/'
open(P+'Main.dc.html','w').write(build_main.build())
for k,f in build_rest.FILES.items(): open(P+k+'.dc.html','w').write(f())
