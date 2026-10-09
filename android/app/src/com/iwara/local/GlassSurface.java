package com.iwara.local;

import android.content.Context;
import android.graphics.*;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.widget.FrameLayout;
import java.io.*;

/** Small bounded backdrop. AGSL is licensed from AndroidLiquidGlassView 1.1.0.
 * The source must be a sibling, never an ancestor containing this surface.
 * No timer, screenshot bitmap, perpetual animation, or whole-window blur. */
public final class GlassSurface extends FrameLayout {
    private ViewGroup source;
    private Renderer renderer;
    private final float density, radius;
    private final Paint edge = new Paint(Paint.ANTI_ALIAS_FLAG);
    private boolean dirty = true;
    private int recordings;
    private long lastRecordAt;
    private final ViewTreeObserver.OnPreDrawListener preDraw = () -> {
        long now = SystemClock.uptimeMillis();
        if (renderer != null && getVisibility() == VISIBLE && dirty && now - lastRecordAt >= 80) {
            dirty = false;
            try { renderer.record(); recordings++; lastRecordAt = now; invalidate(); }
            catch (RuntimeException error) { fallback(error); }
        }
        return true;
    };
    private final ViewTreeObserver.OnScrollChangedListener scroll = () -> dirty = true;

    public GlassSurface(Context context) {
        super(context); density=getResources().getDisplayMetrics().density; radius=36*density;
        setWillNotDraw(false); setClipToOutline(true); setElevation(9*density);
        GradientDrawable background=new GradientDrawable(); background.setColor(0xEDFAFCFF);
        background.setCornerRadius(radius); setBackground(background);
        edge.setStyle(Paint.Style.STROKE); edge.setStrokeWidth(density);
        edge.setShader(new LinearGradient(0,0,0,72*density,new int[]{0xFFFFFFFF,0x80C7D9EF,0xDFFFFFFF},null,Shader.TileMode.CLAMP));
    }
    public void bind(ViewGroup view) {
        if(isAttachedToWindow()) throw new IllegalStateException("Bind before attaching");
        ViewGroup parent=view; while(parent!=null){if(parent==this)throw new IllegalArgumentException("Recursive glass source");parent=parent.getParent() instanceof ViewGroup?(ViewGroup)parent.getParent():null;}
        source=view;
    }
    public boolean isUsingShader(){return renderer!=null;}
    public int getRecordings(){return recordings;}
    /** Re-record the small navigation backdrop once after the page contents change. */
    public void refreshBackdrop(){dirty=true;postInvalidateOnAnimation();}
    @Override protected void onAttachedToWindow(){
        super.onAttachedToWindow();
        if(source!=null && Build.VERSION.SDK_INT>=33){
            try{renderer=new ShaderRenderer();}catch(RuntimeException error){fallback(error);}
            if(renderer!=null){source.getViewTreeObserver().addOnPreDrawListener(preDraw);source.getViewTreeObserver().addOnScrollChangedListener(scroll);dirty=true;}
        }
    }
    @Override protected void onDetachedFromWindow(){
        if(source!=null && source.getViewTreeObserver().isAlive()){source.getViewTreeObserver().removeOnPreDrawListener(preDraw);source.getViewTreeObserver().removeOnScrollChangedListener(scroll);}
        if(renderer!=null)renderer.close();renderer=null;super.onDetachedFromWindow();
    }
    @Override protected void onSizeChanged(int w,int h,int oldw,int oldh){super.onSizeChanged(w,h,oldw,oldh);dirty=true;}
    @Override protected void onDraw(Canvas canvas){
        super.onDraw(canvas);
        if(renderer!=null && canvas.isHardwareAccelerated()){
            try{renderer.draw(canvas);}catch(RuntimeException error){fallback(error);}
        }
        canvas.drawRoundRect(density,density,getWidth()-density,getHeight()-density,radius,radius,edge);
    }
    private void fallback(RuntimeException error){
        Log.w("IwaraGlass","Glass renderer unavailable; using translucent fallback",error);
        if(renderer!=null)renderer.close();renderer=null;
    }
    private interface Renderer {void record();void draw(Canvas canvas);void close();}

    /** Kept separate so Android 8-12 do not load API 33 shader classes. */
    @androidx.annotation.RequiresApi(33)
    private final class ShaderRenderer implements Renderer {
        private final RenderNode node=new RenderNode("IwaraGlassNavigation");
        private final RuntimeShader shader;
        private final int[] sourceLocation=new int[2], hostLocation=new int[2];
        private int width,height;
        ShaderRenderer(){
            StringBuilder text=new StringBuilder();
            try(BufferedReader reader=new BufferedReader(new InputStreamReader(getResources().openRawResource(R.raw.liquidglass_effect),"UTF-8"))){String line;while((line=reader.readLine())!=null)text.append(line).append('\n');}
            catch(IOException error){throw new IllegalStateException("Cannot load glass shader",error);}
            shader=new RuntimeShader(text.toString());
        }
        public void record(){
            int w=getWidth(),h=getHeight();if(w<=0||h<=0)return;
            if(width!=w||height!=h){
                width=w;height=h;node.setPosition(0,0,w,h);
                shader.setFloatUniform("size",(float)w,(float)h);shader.setFloatUniform("offset",0f,0f);
                shader.setFloatUniform("cornerRadii",radius,radius,radius,radius);
                shader.setFloatUniform("refractionHeight",16*density);shader.setFloatUniform("refractionAmount",-22*density);
                shader.setFloatUniform("depthEffect",.08f);shader.setFloatUniform("chromaticAberration",.12f);
                shader.setFloatUniform("contrast",0f);shader.setFloatUniform("whitePoint",0f);shader.setFloatUniform("chromaMultiplier",1f);
                shader.setFloatUniform("tintColor",.97f,.985f,1f);shader.setFloatUniform("tintAlpha",.72f);
                RenderEffect effect=RenderEffect.createRuntimeShaderEffect(shader,"content");
                node.setRenderEffect(RenderEffect.createChainEffect(effect,RenderEffect.createBlurEffect(7*density,7*density,Shader.TileMode.CLAMP)));
            }
            source.getLocationInWindow(sourceLocation);getLocationInWindow(hostLocation);
            Canvas recording=node.beginRecording(w,h);
            try{recording.clipRect(0,0,w,h);recording.translate(sourceLocation[0]-hostLocation[0],sourceLocation[1]-hostLocation[1]);source.draw(recording);}finally{node.endRecording();}
        }
        public void draw(Canvas canvas){canvas.drawRenderNode(node);}
        public void close(){node.discardDisplayList();node.setRenderEffect(null);}
    }
}
